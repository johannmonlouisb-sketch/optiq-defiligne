// netlify/functions/agent-directif.js
const Anthropic = require('@anthropic-ai/sdk');

const NOTION_TOKEN     = process.env.NOTION_TOKEN;
const DB_KIZEO         = '4326bdb2-994b-4250-9759-a897ff7a4a1f';
const DB_INTERVENTIONS = '3ab30393-8dd2-4f10-98e4-b7f7b1c91f60';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM = `Tu es l'agent de planification de Défi Ligne, spécialisée dans la maintenance de défibrillateurs (DAE) et PAD PAK.

Tu aides à planifier les tournées de techniciens (HERBET, BEUZELIN, etc.) en tenant compte :
- Des urgences PAD PAK : expired (⚠️ expiré), critical (🔴 ≤30j), urgent (🟠 ≤90j), soon (🟡 ≤180j)
- Des maintenances annuelles : overdue (🔴 en retard), critical, urgent
- De la proximité géographique (regroupe les sites par département = 2 premiers chiffres du code postal)
- Des infos Kizeo : modèle DAE, numéro de série, dernier technicien, dernière visite

Règles de planification :
- Max 10 sites par jour par technicien (~8h de travail)
- Priorité absolue aux sites expired/overdue
- Regrouper par zone géographique cohérente (même département ou départements voisins)
- Préférer les tournées circulaires (départ/retour Vernouillet 78540)
- Mentionner dans le motif si c'est PAD PAK, maintenance annuelle, ou les deux

Quand tu proposes un plan :
1. Utilise get_kizeo_sites pour récupérer les sites
2. Groupe-les géographiquement par code postal
3. Répartis en journées logiques
4. Appelle propose_plan pour afficher le plan à l'utilisateur
5. N'écris JAMAIS dans Notion sans confirmation explicite

Réponds toujours en français, sois concis et pratique.`;

const TOOLS = [
  {
    name: 'get_kizeo_sites',
    description: 'Récupère les sites depuis la base Kizeo Notion. Retourne : nom, adresse, ville, code postal, urgence PAD PAK, urgence annuelle, technicien, modèle DAE, dernière visite, prochaine expiration, prochaine maintenance annuelle.',
    input_schema: {
      type: 'object',
      properties: {
        urgence_padpak: {
          type: 'array',
          items: { type: 'string', enum: ['expired','critical','urgent','soon','ok','unknown'] },
          description: 'Filtrer par urgences PAD PAK (ex: ["expired","critical"])',
        },
        urgence_annuelle: {
          type: 'array',
          items: { type: 'string', enum: ['overdue','critical','urgent','soon','ok','unknown'] },
          description: 'Filtrer par urgences maintenance annuelle',
        },
        technicien: { type: 'string', description: 'Nom partiel du technicien (ex: HERBET, BEUZELIN)' },
        limit: { type: 'number', description: 'Nombre max de sites (défaut 60, max 100)' },
      },
    },
  },
  {
    name: 'get_existing_interventions',
    description: 'Récupère les interventions déjà planifiées dans Notion sur une plage de dates pour éviter les doublons.',
    input_schema: {
      type: 'object',
      properties: {
        date_from: { type: 'string', description: 'Date début YYYY-MM-DD' },
        date_to:   { type: 'string', description: 'Date fin YYYY-MM-DD' },
        technicien: { type: 'string', description: 'Filtrer par technicien (optionnel)' },
      },
      required: ['date_from', 'date_to'],
    },
  },
  {
    name: 'propose_plan',
    description: 'Affiche le plan proposé à l\'utilisateur pour validation. Le plan ne sera écrit dans Notion QU\'APRÈS confirmation.',
    input_schema: {
      type: 'object',
      properties: {
        resume: { type: 'string', description: 'Résumé du plan en 2-3 phrases' },
        jours: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              date:       { type: 'string', description: 'YYYY-MM-DD' },
              technicien: { type: 'string' },
              zone:       { type: 'string', description: 'Ex: Île-de-France Nord, Normandie' },
              km_estime:  { type: 'number', description: 'KM estimés pour la journée' },
              note:       { type: 'string', description: 'Remarque sur la journée' },
              sites: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    notion_id:        { type: 'string' },
                    nom:              { type: 'string' },
                    adresse:          { type: 'string' },
                    ville:            { type: 'string' },
                    code_postal:      { type: 'string' },
                    urgence_padpak:   { type: 'string' },
                    urgence_annuelle: { type: 'string' },
                    motif:            { type: 'string', description: 'Ex: PAD PAK expiré + Maintenance annuelle en retard' },
                  },
                  required: ['nom', 'adresse', 'ville', 'motif'],
                },
              },
            },
            required: ['date', 'technicien', 'sites'],
          },
        },
      },
      required: ['resume', 'jours'],
    },
  },
];

// ── Handler principal ─────────────────────────────────────────────────────────

exports.handler = async (event) => {
  const cors = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST')   return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  try {
    const body = JSON.parse(event.body || '{}');

    // Mode confirmation : écrire le plan validé dans Notion
    if (body.confirmPlan && body.plan) {
      const result = await executePlan(body.plan);
      return { statusCode: 200, headers: cors, body: JSON.stringify(result) };
    }

    // Mode conversation : appel Claude
    const { messages = [] } = body;
    const response = await runAgent(messages);
    return { statusCode: 200, headers: cors, body: JSON.stringify(response) };

  } catch(e) {
    console.error(e);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};

// ── Boucle agent Claude ───────────────────────────────────────────────────────

async function runAgent(messages) {
  const claudeMsgs = messages.map(m => ({ role: m.role, content: m.content }));
  let pendingPlan = null;
  let lastText = '';

  for (let turn = 0; turn < 5; turn++) {
    const resp = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM,
      tools: TOOLS,
      messages: claudeMsgs,
    });

    // Collecter texte et tool_use
    const textBlocks = resp.content.filter(b => b.type === 'text');
    const toolBlocks = resp.content.filter(b => b.type === 'tool_use');
    lastText = textBlocks.map(b => b.text).join('\n');

    // Fin si pas de tool_use
    if (resp.stop_reason === 'end_turn' || toolBlocks.length === 0) break;

    // Exécuter les outils
    claudeMsgs.push({ role: 'assistant', content: resp.content });
    const toolResults = [];

    for (const tool of toolBlocks) {
      let result;
      try {
        if (tool.name === 'get_kizeo_sites') {
          result = await toolGetKizeoSites(tool.input);
        } else if (tool.name === 'get_existing_interventions') {
          result = await toolGetInterventions(tool.input);
        } else if (tool.name === 'propose_plan') {
          pendingPlan = tool.input;
          result = { status: 'plan_affiché', message: 'Le plan a été transmis à l\'utilisateur pour validation.' };
        }
      } catch(e) {
        result = { error: e.message };
      }
      toolResults.push({ type: 'tool_result', tool_use_id: tool.id, content: JSON.stringify(result) });
    }

    claudeMsgs.push({ role: 'user', content: toolResults });

    // Si plan proposé, on arrête la boucle (attend confirmation)
    if (pendingPlan) break;
  }

  return { text: lastText, plan: pendingPlan };
}

// ── Outils ────────────────────────────────────────────────────────────────────

async function toolGetKizeoSites({ urgence_padpak, urgence_annuelle, technicien, limit = 60 }) {
  const filters = [];

  if (urgence_padpak?.length) {
    filters.push({
      or: urgence_padpak.map(u => ({ property: 'Urgence PAD PAK', select: { equals: u } })),
    });
  }
  if (urgence_annuelle?.length) {
    filters.push({
      or: urgence_annuelle.map(u => ({ property: 'Urgence Annuelle', select: { equals: u } })),
    });
  }
  if (technicien) {
    filters.push({ property: 'Technicien référent', rich_text: { contains: technicien } });
  }

  const body = {
    page_size: Math.min(limit, 100),
    sorts: [{ property: 'Prochaine Expiration', direction: 'ascending' }],
  };
  if (filters.length === 1) body.filter = filters[0];
  else if (filters.length > 1) body.filter = { and: filters };

  const data = await notionReq('POST', `/databases/${DB_KIZEO}/query`, body);

  return data.results.map(p => {
    const g = (k, type) => {
      const prop = p.properties[k];
      if (!prop) return null;
      if (type === 'title')    return prop.title?.[0]?.plain_text || null;
      if (type === 'text')     return prop.rich_text?.[0]?.plain_text || null;
      if (type === 'select')   return prop.select?.name || null;
      if (type === 'date')     return prop.date?.start || null;
      return null;
    };
    return {
      notion_id:        p.id,
      nom:              g('Nom Site', 'title'),
      societe:          g('Société', 'text'),
      adresse:          g('Adresse', 'text'),
      code_postal:      g('Code Postal', 'text'),
      ville:            g('Ville', 'text'),
      technicien:       g('Technicien référent', 'text'),
      dae_modele:       g('Modèle DAE', 'text'),
      dae_serial:       g('N° Série DAE', 'text'),
      urgence_padpak:   g('Urgence PAD PAK', 'select'),
      urgence_annuelle: g('Urgence Annuelle', 'select'),
      prochaine_exp:    g('Prochaine Expiration', 'date'),
      derniere_visite:  g('Dernière Intervention Kizeo', 'date'),
      prochaine_annuelle: g('Prochaine Maintenance Annuelle', 'date'),
      type_intervention:  g('Type intervention', 'select'),
    };
  });
}

async function toolGetInterventions({ date_from, date_to, technicien }) {
  const filters = [
    { property: 'Date intervention', date: { on_or_after: date_from } },
    { property: 'Date intervention', date: { on_or_before: date_to } },
  ];
  if (technicien) {
    filters.push({ property: 'Technicien', select: { equals: technicien } });
  }
  const data = await notionReq('POST', `/databases/${DB_INTERVENTIONS}/query`, {
    page_size: 100,
    filter: { and: filters },
    sorts: [{ property: 'Date intervention', direction: 'ascending' }],
  });
  return data.results.map(p => ({
    societe:   p.properties['Société']?.title?.[0]?.plain_text,
    adresse:   p.properties['Adresse Site']?.rich_text?.[0]?.plain_text,
    date:      p.properties['Date intervention']?.date?.start,
    technicien: p.properties['Technicien']?.select?.name,
    motif:     p.properties['Motif']?.rich_text?.[0]?.plain_text,
  }));
}

// ── Exécution du plan confirmé ────────────────────────────────────────────────

async function executePlan(plan) {
  let created = 0;
  const errors = [];

  for (const jour of plan.jours || []) {
    for (const site of jour.sites || []) {
      try {
        const urgLabel = buildUrgLabel(site);
        await notionReq('POST', '/pages', {
          parent: { database_id: DB_INTERVENTIONS },
          properties: {
            'Société':          { title: [{ text: { content: (site.nom || '').substring(0, 2000) } }] },
            'Adresse Site':     { rich_text: [{ text: { content: (site.adresse || '').substring(0, 2000) } }] },
            'Date intervention':{ date: { start: jour.date } },
            'INTERVENTION':     { multi_select: [{ name: 'Agent IA' }] },
            'Motif':            { rich_text: [{ text: { content: `${site.motif || ''} ${urgLabel}`.trim().substring(0, 2000) } }] },
            'Urgent':           { rich_text: [{ text: { content: isUrgent(site) ? 'Oui' : 'Non' } }] },
            'Terminer':         { checkbox: false },
            'Echec':            { checkbox: false },
          },
        });
        created++;
        await sleep(300);
      } catch(e) {
        errors.push({ site: site.nom, error: e.message });
      }
    }
  }
  return { success: true, created, errors };
}

function buildUrgLabel(site) {
  const parts = [];
  const padMap = { expired:'⚠️ PAD PAK EXPIRÉ', critical:'🔴 PAD PAK CRITIQUE', urgent:'🟠 PAD PAK URGENT', soon:'🟡 PAD PAK BIENTÔT' };
  const annMap = { overdue:'🔴 VISITE ANNUELLE EN RETARD', critical:'🔴 VISITE ANNUELLE CRITIQUE', urgent:'🟠 VISITE ANNUELLE URGENTE' };
  if (padMap[site.urgence_padpak]) parts.push(padMap[site.urgence_padpak]);
  if (annMap[site.urgence_annuelle]) parts.push(annMap[site.urgence_annuelle]);
  return parts.join(' | ');
}
function isUrgent(site) {
  return ['expired','critical'].includes(site.urgence_padpak) || ['overdue','critical'].includes(site.urgence_annuelle);
}

// ── Utilitaires ───────────────────────────────────────────────────────────────

async function notionReq(method, path, body) {
  const fetch = (...a) => import('node-fetch').then(({ default: f }) => f(...a));
  const res = await (await fetch)(`https://api.notion.com/v1${path}`, {
    method,
    headers: { Authorization: `Bearer ${NOTION_TOKEN}`, 'Notion-Version': '2022-06-28', 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { const e = await res.text(); throw new Error(`Notion ${res.status}: ${e}`); }
  return res.json();
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
