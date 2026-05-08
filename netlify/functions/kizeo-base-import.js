// netlify/functions/kizeo-base-import.js
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_DB_KIZEO = process.env.NOTION_DB_KIZEO || '4326bdb2994b42509759a897ff7a4a1f';
const NOTION_DB_INTERVENTIONS = process.env.NOTION_DB_INTERVENTIONS || '3ab303938dd24f1098e4b7f7b1c91f60';

const COL_MAP = {
  technicien: "Votre référent Défi Ligne",
  typeIntervention: "Type d'intervention",
  categorieIntervention: "Catégorie d'intervention",
  societe: "SIEGE CLIENT:Société",
  nomSite: "NOM DU SITE (si différent du nom du siège)",
  adresse: "ADRESSE:Adresse",
  codePostal: "ADRESSE:Codepostal",
  ville: "ADRESSE:Ville",
  geoloc: "Géolocalisation du SITE d'installation",
  daeModele: "Modèle du DAE installé",
  daeModele2: "Modèle DAE",
  daeSerial: "SCAN du N° de série DAE",
  datePremptionElectrodes: "Saisie Date de péremption électrodes",
  datePremptionBatterie: "Saisie Date de péremption Batterie",
  datePremptionPadPakAdulte: "Saisie Date de péremption pad pak adulte",
  datePremptionPadPakPedia: "Date de péremption pad pak pédiatrique",
  dateDebut: "Début intervention : Date et Heure",
};

exports.handler = async (event) => {
  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

  try {
    const { csvContent, dryRun = false } = JSON.parse(event.body || '{}');
    if (!csvContent) return { statusCode: 400, headers, body: JSON.stringify({ error: 'csvContent requis' }) };

    const records = parseKizeoBase(csvContent);
    const urgencyBreakdown = getBreakdown(records);

    if (dryRun) {
      return { statusCode: 200, headers, body: JSON.stringify({ total: records.length, urgencyBreakdown, sample: records.slice(0,3) }) };
    }

    let sitesImported = 0, maintenancesCreated = 0, errors = [];
    for (const r of records) {
      try {
        await createKizeoSite(r);
        sitesImported++;
        if (!r.isTele && ['expired','critical','urgent','soon'].includes(r.urgency)) {
          await createMaintenance(r);
          maintenancesCreated++;
        }
        await sleep(300);
      } catch(e) {
        errors.push({ site: r.nomSite, error: e.message });
      }
    }

    return { statusCode: 200, headers, body: JSON.stringify({ success: true, total: records.length, sitesImported, maintenancesCreated, errors, urgencyBreakdown }) };
  } catch(e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};

function parseKizeoBase(text) {
  const firstLine = text.split('\n')[0];
  const sep = firstLine.split(';').length > firstLine.split(',').length ? ';' : ',';
  const lines = text.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const headers = splitLine(lines[0], sep);
  const idx = {};
  Object.entries(COL_MAP).forEach(([k,col]) => {
    const i = headers.findIndex(h => norm(h) === norm(col));
    if (i >= 0) idx[k] = i;
  });
  const records = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitLine(lines[i], sep);
    if (cols.length < 5) continue;
    const get = k => idx[k] !== undefined ? (cols[idx[k]]||'').trim() : '';
    const expirations = {
      electrodes: parseDate(get('datePremptionElectrodes')),
      batterie: parseDate(get('datePremptionBatterie')),
      padPakAdulte: parseDate(get('datePremptionPadPakAdulte')),
      padPakPedia: parseDate(get('datePremptionPadPakPedia')),
    };
    const allDates = Object.values(expirations).filter(Boolean);
    const earliest = allDates.length ? allDates.sort((a,b) => new Date(a)-new Date(b))[0] : null;
    const typeIntv = get('typeIntervention') || get('categorieIntervention');
    const isTele = typeIntv.toUpperCase().includes('TELE') || typeIntv.toUpperCase().includes('TÉLÉ');
    const societe = get('societe');
    const adresse = [get('adresse'), get('codePostal'), get('ville')].filter(Boolean).join(' ');
    if (!adresse && !societe) continue;
    records.push({
      technicien: get('technicien'), societe,
      nomSite: get('nomSite') || societe,
      adresse, codePostal: get('codePostal'), ville: get('ville'),
      daeModele: get('daeModele') || get('daeModele2'),
      daeSerial: get('daeSerial'), typeIntv, isTele,
      dateIntervention: parseDate(get('dateDebut')),
      expirations, earliestExpiration: earliest,
      urgency: calcUrgency(earliest),
    });
  }
  return records;
}

async function createKizeoSite(r) {
  const props = {
    'Nom Site': { title: [{ text: { content: (r.nomSite||r.societe||'Inconnu').substring(0,2000) } }] },
  };
  const t = (k,v) => { if(v) props[k] = { rich_text:[{text:{content:String(v).substring(0,2000)}}] }; };
  const d = (k,v) => { if(v) props[k] = { date:{start:v} }; };
  const s = (k,v) => { if(v) props[k] = { select:{name:v} }; };
  t('Société',r.societe); t('Adresse',r.adresse); t('Code Postal',r.codePostal);
  t('Ville',r.ville); t('Technicien référent',r.technicien);
  t('Modèle DAE',r.daeModele); t('N° Série DAE',r.daeSerial);
  s('Urgence PAD PAK',r.urgency);
  s('Type intervention', r.isTele ? 'TÉLÉ-ASSISTANCE' : 'PASSAGE PHYSIQUE');
  d('Prochaine Expiration',r.earliestExpiration);
  d('Expiration Électrodes',r.expirations?.electrodes);
  d('Expiration Batterie',r.expirations?.batterie);
  d('Expiration PAD PAK Adulte',r.expirations?.padPakAdulte);
  d('Expiration PAD PAK Pédiatrique',r.expirations?.padPakPedia);
  d('Dernière Intervention Kizeo',r.dateIntervention);
  props['Maintenance planifiée'] = { checkbox: false };
  await notionReq('POST','/pages',{ parent:{database_id:NOTION_DB_KIZEO}, properties:props });
}

async function createMaintenance(r) {
  const expDate = new Date(r.earliestExpiration);
  const mDate = new Date(expDate);
  mDate.setDate(mDate.getDate() - 60);
  if (mDate < new Date()) mDate.setTime(Date.now() + 7*86400000);
  const dateStr = mDate.toISOString().split('T')[0];
  const urgLabel = {expired:'⚠️ EXPIRÉ',critical:'🔴 CRITIQUE',urgent:'🟠 URGENT',soon:'🟡 À PLANIFIER'}[r.urgency]||'';
  await notionReq('POST','/pages',{
    parent:{database_id:NOTION_DB_INTERVENTIONS},
    properties:{
      'Société':{title:[{text:{content:(r.nomSite||r.societe||'').substring(0,2000)}}]},
      'Adresse Site':{rich_text:[{text:{content:(r.adresse||'').substring(0,2000)}}]},
      'Date intervention':{date:{start:dateStr}},
      'INTERVENTION':{multi_select:[{name:'Maintenance PAD PAK'}]},
      'Motif':{rich_text:[{text:{content:`Maintenance préventive PAD PAK — ${urgLabel} — Expiration: ${r.earliestExpiration}`}}]},
      'Urgent':{rich_text:[{text:{content:(r.urgency==='expired'||r.urgency==='critical')?'Oui':'Non'}}]},
      'Terminer':{checkbox:false},'Echec':{checkbox:false},
    }
  });
}

async function notionReq(method, path, body) {
  const res = await fetch(`https://api.notion.com/v1${path}`,{
    method, headers:{'Authorization':`Bearer ${NOTION_TOKEN}`,'Notion-Version':'2022-06-28','Content-Type':'application/json'},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { const e = await res.text(); throw new Error(`Notion ${res.status}: ${e}`); }
  return res.json();
}

function splitLine(line, sep) {
  const r=[];let c='';let q=false;
  for(const ch of line){ if(ch==='"'){q=!q;}else if(ch===sep&&!q){r.push(c);c='';}else c+=ch; }
  r.push(c); return r;
}
function norm(s){ return s.trim().toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g,''); }
function parseDate(raw) {
  if(!raw||!raw.trim()) return null;
  const m=raw.match(/(\d{2})\/(\d{2})\/(\d{4})/);
  if(m) return `${m[3]}-${m[2]}-${m[1]}`;
  if(/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.substring(0,10);
  return null;
}
function calcUrgency(d) {
  if(!d) return 'unknown';
  const diff=Math.floor((new Date(d)-new Date())/86400000);
  if(diff<0) return 'expired'; if(diff<=30) return 'critical';
  if(diff<=90) return 'urgent'; if(diff<=180) return 'soon'; return 'ok';
}
function getBreakdown(records) {
  const b={expired:0,critical:0,urgent:0,soon:0,ok:0,unknown:0};
  records.forEach(r=>b[r.urgency]=(b[r.urgency]||0)+1); return b;
}
const sleep = ms => new Promise(r=>setTimeout(r,ms));
