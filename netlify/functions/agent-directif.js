// netlify/functions/agent-directif.js
const NOTION_TOKEN     = process.env.NOTION_TOKEN;
const GROQ_API_KEY     = process.env.GROQ_API_KEY || process.env.GROQ;
const DB_KIZEO         = '4326bdb2-994b-4250-9759-a897ff7a4a1f';
const DB_INTERVENTIONS = '3ab30393-8dd2-4f10-98e4-b7f7b1c91f60';
const GROQ_URL         = 'https://api.groq.com/openai/v1/chat/completions';
const GROQ_MODEL       = 'llama-3.3-70b-versatile'; // 12k TPM (> 6k pour 8b sur ce compte)

const SYSTEM = `Tu es l'agent de planification de Défi Ligne, spécialisée dans la maintenance de défibrillateurs (DAE) et PAD PAK.

Tu aides à planifier les tournées de techniciens (HERBET, BEUZELIN, etc.) en tenant compte :
- Des urgences PAD PAK : expired (⚠️ expiré), critical (🔴 ≤30j), urgent (🟠 ≤90j), soon (🟡 ≤180j)
- Des maintenances annuelles : overdue (🔴 en retard), critical, urgent
- De la proximité géographique (regroupe les sites par département = 2 premiers chiffres du code postal)
- Des infos Kizeo retournées en compact : id, nom, adr (CP ville), tech, pp (PAD PAK urgence), ann (annuelle urgence), exp (expiration)

Règles de planification :
- Max 10 sites par jour par technicien (~8h de travail)
- Priorité absolue aux sites expired/overdue
- Regrouper par zone géographique cohérente (même département ou départements voisins)
- Préférer les tournées circulaires (départ/retour Vernouillet 78540)
- Mentionner dans le motif si c'est PAD PAK, maintenance annuelle, ou les deux

Quand tu proposes un plan :
1. Utilise get_kizeo_sites pour récupérer les sites
2. Groupe-les géographiquement par code postal (2 premiers chiffres = département)
3. Répartis en journées logiques (max 10 sites/jour)
4. Appelle propose_plan pour afficher le plan à l'utilisateur
5. N'écris JAMAIS dans Notion sans confirmation explicite de l'utilisateur

Réponds toujours en français, sois concis et pratique.`;

// ── Définition des outils (format OpenAI / Groq) ─────────────────────────────
const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_kizeo_sites',
      description: 'Récupère les sites depuis la base Kizeo Notion. Retourne (format compact) : id, nom, adr (CP+ville), tech (technicien), pp (urgence PAD PAK), ann (urgence annuelle), exp (prochaine expiration).',
      parameters: {
        type: 'object',
        properties: {
          urgence_padpak: {
            type: 'array',
            items: { type: 'string', enum: ['expired','critical','urgent','soon','ok','unknown'] },
            description: 'Filtrer par urgences PAD PAK ex: ["expired","critical"]',
          },
          urgence_annuelle: {
            type: 'array',
            items: { type: 'string', enum: ['overdue','critical','urgent','soon','ok','unknown'] },
            description: 'Filtrer par urgences maintenance annuelle',
          },
          technicien: { type: 'string', description: 'Nom partiel du technicien ex: HERBET' },
          limit: { type: 'number', description: 'Nombre max de sites (défaut 15, max 20)' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_existing_interventions',
      description: 'Récupère les interventions déjà planifiées dans Notion sur une plage de dates pour éviter les doublons.',
      parameters: {
        type: 'object',
        properties: {
          date_from:  { type: 'string', description: 'Date début YYYY-MM-DD' },
          date_to:    { type: 'string', description: 'Date fin YYYY-MM-DD' },
          technicien: { type: 'string', description: 'Filtrer par technicien (optionnel)' },
        },
        required: ['date_from', 'date_to'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_plan',
      description: 'Affiche le plan proposé à l\'utilisateur pour validation. Le plan ne sera écrit dans Notion QU\'APRÈS confirmation.',
      parameters: {
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
                km_estime:  { type: 'number' },
                note:       { type: 'string' },
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
                      urgence_padpak:   { anyOf: [{ type: 'string' }, { type: 'null' }] },
                      urgence_annuelle: { anyOf: [{ type: 'string' }, { type: 'null' }] },
                      motif:            { type: 'string' },
                    },
                    required: ['nom', 'motif'],
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

  if (!GROQ_API_KEY) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'GROQ_API_KEY manquante — configurez-la dans Netlify' }) };

  try {
    const body = JSON.parse(event.body || '{}');

    if (body.confirmPlan && body.plan) {
      const result = await executePlan(body.plan);
      return { statusCode: 200, headers: cors, body: JSON.stringify(result) };
    }

    const { messages = [] } = body;
    const response = await runAgent(messages);
    return { statusCode: 200, headers: cors, body: JSON.stringify(response) };

  } catch(e) {
    console.error(e);
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};

// ── Boucle agent Groq (format OpenAI) ────────────────────────────────────────
async function runAgent(messages) {
  // Convertit l'historique UI en format OpenAI
  const groqMsgs = [
    { role: 'system', content: SYSTEM },
    ...messages.map(m => ({ role: m.role, content: m.content })),
  ];

  let pendingPlan = null;
  let lastText = '';

  for (let turn = 0; turn < 6; turn++) {
    const res = await groqCall({
      model: GROQ_MODEL,
      max_tokens: 2048,
      temperature: 0.3,
      messages: groqMsgs,
      tools: TOOLS,
      tool_choice: 'auto',
    });

    const choice = res.choices?.[0];
    const msg = choice?.message;

    lastText = msg?.content || lastText;

    // Fin si pas d'appel d'outil
    if (choice?.finish_reason === 'stop' || !msg?.tool_calls?.length) break;

    // Ajouter la réponse assistant avec tool_calls
    groqMsgs.push({ role: 'assistant', content: msg.content || null, tool_calls: msg.tool_calls });

    // Exécuter chaque outil
    for (const tc of msg.tool_calls) {
      let result;
      try {
        const args = JSON.parse(tc.function.arguments || '{}');
        if (tc.function.name === 'get_kizeo_sites') {
          result = await toolGetKizeoSites(args);
        } else if (tc.function.name === 'get_existing_interventions') {
          result = await toolGetInterventions(args);
        } else if (tc.function.name === 'propose_plan') {
          pendingPlan = args;
          result = { status: 'plan_affiché', message: 'Plan transmis à l\'utilisateur pour validation.' };
        } else {
          result = { error: `Outil inconnu: ${tc.function.name}` };
        }
      } catch(e) {
        result = { error: e.message };
      }

      groqMsgs.push({
        role: 'tool',
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }

    // Si plan proposé, on attend la confirmation utilisateur
    if (pendingPlan) {
      // Dernier tour pour récupérer le texte de conclusion
      const finalRes = await groqCall({ model: GROQ_MODEL, max_tokens: 512, temperature: 0.3, messages: groqMsgs, tools: TOOLS, tool_choice: 'none' });
      lastText = finalRes.choices?.[0]?.message?.content || lastText;
      break;
    }
  }

  return { text: lastText, plan: pendingPlan };
}

// ── Outils ────────────────────────────────────────────────────────────────────
async function toolGetKizeoSites({ urgence_padpak, urgence_annuelle, technicien, limit = 15 }) {
  const filters = [];

  if (urgence_padpak?.length) {
    filters.push({ or: urgence_padpak.map(u => ({ property: 'Urgence PAD PAK', select: { equals: u } })) });
  }
  if (urgence_annuelle?.length) {
    filters.push({ or: urgence_annuelle.map(u => ({ property: 'Urgence Annuelle', select: { equals: u } })) });
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
      if (type === 'title')  return prop.title?.[0]?.plain_text || null;
      if (type === 'text')   return prop.rich_text?.[0]?.plain_text || null;
      if (type === 'select') return prop.select?.name || null;
      if (type === 'date')   return prop.date?.start || null;
      return null;
    };
    // Champs compacts pour limiter les tokens Groq (plan gratuit 12k TPM)
    return {
      id:   p.id,
      nom:  g('Nom Site', 'title'),
      adr:  [g('Code Postal', 'text'), g('Ville', 'text')].filter(Boolean).join(' '),
      tech: g('Technicien référent', 'text'),
      pp:   g('Urgence PAD PAK', 'select'),
      ann:  g('Urgence Annuelle', 'select'),
      exp:  g('Prochaine Expiration', 'date'),
    };
  });
}

async function toolGetInterventions({ date_from, date_to, technicien }) {
  const filters = [
    { property: 'Date intervention', date: { on_or_after: date_from } },
    { property: 'Date intervention', date: { on_or_before: date_to } },
  ];
  if (technicien) filters.push({ property: 'Technicien', select: { equals: technicien } });

  const data = await notionReq('POST', `/databases/${DB_INTERVENTIONS}/query`, {
    page_size: 100,
    filter: { and: filters },
    sorts: [{ property: 'Date intervention', direction: 'ascending' }],
  });

  return data.results.map(p => ({
    societe:    p.properties['Société']?.title?.[0]?.plain_text,
    adresse:    p.properties['Adresse Site']?.rich_text?.[0]?.plain_text,
    date:       p.properties['Date intervention']?.date?.start,
    motif:      p.properties['Motif']?.rich_text?.[0]?.plain_text,
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
            'Société':           { title: [{ text: { content: (site.nom || '').substring(0, 2000) } }] },
            'Adresse Site':      { rich_text: [{ text: { content: (site.adresse || '').substring(0, 2000) } }] },
            'Date intervention': { date: { start: jour.date } },
            'INTERVENTION':      { multi_select: [{ name: 'Agent IA' }] },
            'Motif':             { rich_text: [{ text: { content: `${site.motif || ''} ${urgLabel}`.trim().substring(0, 2000) } }] },
            'Urgent':            { rich_text: [{ text: { content: isUrgent(site) ? 'Oui' : 'Non' } }] },
            'Terminer':          { checkbox: false },
            'Echec':             { checkbox: false },
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

// ── Utilitaires ───────────────────────────────────────────────────────────────
function buildUrgLabel(site) {
  const parts = [];
  const padMap = { expired:'⚠️ PAD PAK EXPIRÉ', critical:'🔴 PAD PAK CRITIQUE', urgent:'🟠 PAD PAK URGENT', soon:'🟡 PAD PAK BIENTÔT' };
  const annMap = { overdue:'🔴 VISITE ANNUELLE EN RETARD', critical:'🔴 VISITE ANNUELLE CRITIQUE', urgent:'🟠 VISITE ANNUELLE URGENTE' };
  if (padMap[site.urgence_padpak])   parts.push(padMap[site.urgence_padpak]);
  if (annMap[site.urgence_annuelle]) parts.push(annMap[site.urgence_annuelle]);
  return parts.join(' | ');
}

function isUrgent(site) {
  return ['expired','critical'].includes(site.urgence_padpak) || ['overdue','critical'].includes(site.urgence_annuelle);
}

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

// Groq fetch avec retry automatique sur 429 (max 8s d'attente)
async function groqCall(body, retries = 2) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${GROQ_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (res.status === 429 && retries > 0) {
    const err = await res.json().catch(() => ({}));
    const msg = err?.error?.message || '';
    const match = msg.match(/try again in ([\d.]+)s/);
    const wait = match ? Math.min(parseFloat(match[1]) * 1000 + 500, 8000) : 3000;
    await sleep(wait);
    return groqCall(body, retries - 1);
  }
  if (!res.ok) { const e = await res.text(); throw new Error(`Groq error ${res.status}: ${e}`); }
  return res.json();
}
