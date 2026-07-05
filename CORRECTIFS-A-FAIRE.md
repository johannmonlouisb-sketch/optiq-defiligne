# OptiQ — Correctifs à appliquer (defiligne)

Audit du 5 juillet 2026. À traiter dans l'ordre : sécurité d'abord.
Après chaque modif d'un fichier HTML, valider le JS (voir bas de page).

---

## 🔴 1. CRITIQUE — `/api/settings` expose tous les mots de passe

**Problème :** `GET https://optitechx.netlify.app/api/settings` est public et renvoie en clair
le mot de passe admin (`adminCreds.pw`) et les codes PIN de chaque technicien (`techs[].code`).
N'importe qui peut lire cet endpoint et se connecter en admin.

**Fichier :** `netlify/functions/settings.js`

**Correctif :** ne jamais renvoyer les secrets au client. Filtrer la réponse GET.

```js
if (request.method === 'GET') {
  const data = await store.get('settings', { type: 'json' }).catch(() => null) || {}
  // Retirer tout ce qui est sensible avant d'envoyer au navigateur
  const { adminCreds, ...safe } = data
  if (Array.isArray(safe.techs)) {
    safe.techs = safe.techs.map(({ code, ...t }) => t)   // enlève les PIN
  }
  return new Response(JSON.stringify(safe), { status: 200, headers: CORS })
}
```

> Les PIN et le mot de passe admin doivent vivre UNIQUEMENT dans les variables
> d'environnement Netlify (`ADMIN_USER`, `ADMIN_PASS`, `TECH_PINS`), jamais dans le blob
> renvoyé au client. `auth.js` lit déjà `TECH_PINS` en fallback — en faire la source unique.

---

## 🔴 2. CRITIQUE — l'auth admin n'est vérifiée que côté navigateur

**Problème :** `defiligne.html` → `_admAuthValid()` (~ligne 9314) ne regarde qu'un flag
dans le localStorage :
```js
const s=JSON.parse(localStorage.getItem('optiq_session')||'null')
return s?.role==='admin' && ...
```
On peut le forger dans la console : `localStorage.setItem('optiq_session', JSON.stringify({role:'admin',savedAt:Date.now()}))`.
Le token signé (HMAC dans `auth.js`) n'est jamais revérifié.

**Correctif (minimum) :** ajouter une function `netlify/functions/verify.js` qui recalcule le
HMAC du token et le renvoie valide/invalide, puis appeler ce endpoint dans `_admAuthValid()`
avant d'afficher les données. À terme, exiger le token sur chaque endpoint sensible
(`/api/notion`, `/api/settings` POST).

---

## 🟠 3. Secrets en dur (fallbacks) à retirer

- `netlify/functions/auth.js:75` → `const adminPass = process.env.ADMIN_PASS || '7802'`
  → retirer `|| '7802'` et `|| 'defiligne'` (ligne 74). Refuser si l'env var est absente.
- `netlify/functions/auth.js:52` → `AUTH_SECRET || 'optitechx-dev-secret-changeme'`
  → retirer le fallback ; générer un vrai secret dans Netlify.
- `netlify/functions/notion.js:21` → DB ID en dur en fallback : acceptable mais à documenter.

Vérifier ensuite que ces variables existent bien dans **Netlify → Site settings →
Environment variables** : `ADMIN_USER`, `ADMIN_PASS`, `AUTH_SECRET`, `NOTION_TOKEN`, `TECH_PINS`.

---

## 🟡 4. Nettoyage recommandé

- **`defiligne_v3.html`** : un ancien fichier traîne à la racine (publié donc accessible).
  Le supprimer ou le sortir du dossier publié s'il n'est plus utilisé.
- **`brevoApiKey`** (defiligne.html ~6667) : la clé SMS Brevo est saisie côté client et
  stockée dans les settings → même risque que le point 1 si elle finit dans le blob public.
  La router via une Netlify Function comme Notion.
- Le CORS de toutes les functions est `Access-Control-Allow-Origin: *`. Une fois l'auth
  serveur en place, restreindre à `https://optitechx.netlify.app`.

---

## ✅ Validation après chaque modif HTML

```bash
python3 -c "
import re
with open('defiligne.html','r',encoding='utf-8') as f: c=f.read()
scripts=re.findall(r'<script>(.*?)</script>',c,re.DOTALL)
open('/tmp/check.js','w').write('\n'.join(scripts))
"
node --check /tmp/check.js
```

## Priorité

1 et 2 sont urgents (n'importe qui peut prendre le contrôle admin aujourd'hui).
Commence par **changer le mot de passe admin et les PIN** dans Netlify, puis applique le point 1.
