// ═══════════════════════════════════════════════════════════════════════════
// OptiTechX — Mode simulation de tournée (DÉVELOPPEMENT / TEST UNIQUEMENT)
//
// Inactif par défaut. Ne s'active QUE si l'URL contient ?test=true (vérifié
// une seule fois au chargement de la page — jamais de bascule automatique).
// Sans ce paramètre, ce fichier entier ne fait strictement rien.
//
// But : rejouer la logique réelle de tournée (démarrage, ETA, retard/pause,
// arrivée) depuis un ordinateur, sans GPS ni déplacement réel, en réutilisant
// directement les fonctions de production (refreshLiveETAs, startLiveETAs,
// _startTourInterval, _startPosWatch/_stopPosWatch, pauseTournee/resumeTournee)
// — pas une réécriture de leur logique, pour pouvoir réellement détecter les
// bugs qui s'y trouvent.
//
// Garanties d'isolation :
//  - tourRunning / tourStartTime / techRouteLegDurations / _routeOrderedPts
//    sont les VRAIES variables globales de l'appli (réutilisées telles
//    quelles), mais leur valeur "réelle" est sauvegardée avant simulation et
//    restaurée à la fin (simEnd) — la vraie tournée du jour n'est jamais
//    perdue ni écrasée durablement.
//  - Les faux clients utilisent des ids texte préfixés "__SIM_" — ne peuvent
//    jamais entrer en collision avec un vrai id d'intervention (numérique).
//  - startTournee(), endTournee(), saveTourProgress(), _calcETAsHeadless(),
//    calcMap(), pushToKizeo(), pushStatusToNotion(), saveIvs()/saveVF() ne
//    sont JAMAIS appelées par ce fichier — ce sont ces fonctions qui écrivent
//    vers Supabase/Kizeo/Notion ou vers les vraies données clients/tournées.
//  - navigator.geolocation et l'horloge (new Date()/Date.now()) ne sont
//    patchées que si ?test=true est présent, jamais en usage normal.
// ═══════════════════════════════════════════════════════════════════════════
(function(){
  'use strict'
  const SIM_ON = new URLSearchParams(location.search).get('test') === 'true'
  if (!SIM_ON) return

  const RealDate = window.Date

  // ─────────────────────────── Horloge virtuelle ───────────────────────────
  // new Date(...) AVEC arguments continue d'utiliser le vrai constructeur
  // (super(...args)) — seul le "now implicite" (new Date() / Date.now()) est
  // simulé, donc le formatage de dates réel ailleurs dans l'appli n'est
  // jamais affecté par ce patch.
  let simSpeed = 60 // 1s réelle = 60s simulées (1 min) par défaut
  function _defaultVirtualStart(){
    const d = new RealDate()
    d.setHours(9, 0, 0, 0)
    return d.getTime()
  }
  let simBaseVirtualMs = _defaultVirtualStart()
  let simBaseWallMs = RealDate.now()

  function simNowMs(){ return simBaseVirtualMs + (RealDate.now() - simBaseWallMs) * simSpeed }
  function setSimClockMs(ms){ simBaseVirtualMs = ms; simBaseWallMs = RealDate.now() }
  function jumpMinutes(mins){ setSimClockMs(simNowMs() + mins * 60000) }
  function setSimSpeed(mult){
    setSimClockMs(simNowMs()) // rebase pour ne pas sauter dans le temps au changement de vitesse
    simSpeed = parseInt(mult, 10) || 1
  }

  class SimDate extends RealDate {
    constructor(...args){
      if (args.length === 0) super(simNowMs())
      else super(...args)
    }
    static now(){ return simNowMs() }
  }
  window.Date = SimDate

  function simHHMM(){
    return new Date().toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit', timeZone:'Europe/Paris', hour12:false})
  }
  function _hhmmToMin(hhmm){
    if (!hhmm) return null
    const m = /(\d{1,2}):(\d{2})/.exec(hhmm)
    return m ? parseInt(m[1],10)*60 + parseInt(m[2],10) : null
  }

  // ─────────────────────────── GPS simulé ──────────────────────────────────
  const realWatchPosition = navigator.geolocation.watchPosition.bind(navigator.geolocation)
  const realClearWatch = navigator.geolocation.clearWatch.bind(navigator.geolocation)
  const realGetCurrentPosition = navigator.geolocation.getCurrentPosition.bind(navigator.geolocation)
  const SIM_WATCH_ID = 'sim-watch-1'

  // Coordonnées fictives (Île-de-France, à l'écart des vraies adresses clients).
  const SIM_WAYPOINTS = [
    {lat:48.965, lng:1.967, label:'🧪 DÉPART (test)'},
    {lat:48.930, lng:2.010, label:'🧪 Client Test A'},
    {lat:48.895, lng:2.070, label:'🧪 Client Test B'},
    {lat:48.860, lng:2.130, label:'🧪 Client Test C'},
    {lat:48.965, lng:1.967, label:'🧪 ARRIVÉE (test)'},
  ]
  // legs[i] = trajet vers SIM_WAYPOINTS[i+1] ; legs[3] = trajet retour (C → arrivée)
  const SIM_LEGS = [
    {distanceKm:8.0,  durationMin:12, trafficDurationMin:12},
    {distanceKm:6.0,  durationMin:9,  trafficDurationMin:9},
    {distanceKm:5.0,  durationMin:8,  trafficDurationMin:8},
    {distanceKm:10.0, durationMin:15, trafficDurationMin:15},
  ]
  const SIM_STOP_IDS = ['__SIM_A', '__SIM_B', '__SIM_C']

  let simGpsIdx = 0
  let simGpsProgress = 0 // 0..1 — avancement fictif entre SIM_WAYPOINTS[simGpsIdx] et le suivant
  let simGpsPaused = false
  let simGpsTimer = null
  let simGeoCb = null

  function _simCurrentCoords(){
    const a = SIM_WAYPOINTS[simGpsIdx], b = SIM_WAYPOINTS[Math.min(simGpsIdx + 1, SIM_WAYPOINTS.length - 1)]
    const t = simGpsProgress
    return {lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t}
  }

  navigator.geolocation.watchPosition = function(successCb, errorCb, opts){
    if (!simActive) return realWatchPosition(successCb, errorCb, opts)
    simGeoCb = successCb
    simGpsTimer = setInterval(() => {
      if (simGpsPaused || !simGeoCb) return
      const c = _simCurrentCoords()
      simGeoCb({coords:{latitude:c.lat, longitude:c.lng, accuracy:5}})
    }, 2000)
    return SIM_WATCH_ID
  }
  navigator.geolocation.clearWatch = function(id){
    if (id === SIM_WATCH_ID) { clearInterval(simGpsTimer); simGpsTimer = null; simGeoCb = null; return }
    realClearWatch(id)
  }
  navigator.geolocation.getCurrentPosition = function(successCb, errorCb, opts){
    if (!simActive) return realGetCurrentPosition(successCb, errorCb, opts)
    const c = _simCurrentCoords()
    successCb({coords:{latitude:c.lat, longitude:c.lng, accuracy:5}})
  }

  // ─────────────────────────── route-traffic simulé (jamais de vrai appel) ────
  // _refreshRemainingLegFromGPS() (tech.html) appelle POST /api/route-traffic avec
  // la position GPS courante. On intercepte UNIQUEMENT cette route pendant la
  // simulation et on répond localement (distance réelle via _distM déjà présent
  // dans tech.html + vitesse fictive réglable) — jamais d'appel réseau vers la
  // vraie API (payante) pendant un test.
  const realFetch = window.fetch.bind(window)
  let simGpsEtaSpeedKmh = 40 // vitesse fictive ; réduire pour simuler un retard réel (TEST 4)
  window.fetch = function(url, opts){
    const href = (typeof url === 'string') ? url : ((url && url.url) || '')
    if (simActive && href.includes('/api/route-traffic')) {
      let body = {}
      try { body = JSON.parse((opts && opts.body) || '{}') } catch(e) {}
      const wps = body.waypoints || []
      let distanceKm = 0
      if (wps.length >= 2 && typeof _distM === 'function') distanceKm = _distM(wps[0], wps[1]) / 1000
      const durationMin = Math.max(1, Math.round(distanceKm / simGpsEtaSpeedKmh * 60))
      const fakeLeg = {distanceKm: Math.round(distanceKm * 10) / 10, durationMin, trafficDurationMin: durationMin}
      const payload = JSON.stringify({legs:[fakeLeg], totalDistanceKm:fakeLeg.distanceKm, totalDurationMin:durationMin, trafficDurationMin:durationMin, source:'sim'})
      return Promise.resolve(new Response(payload, {status:200, headers:{'Content-Type':'application/json'}}))
    }
    return realFetch(url, opts)
  }

  // ─────────────────────────── État simulation ─────────────────────────────
  let simActive = false
  let simSavedState = null
  let simLog = {demarrage:null, pause:null, dureePause:null, reprise:null, etaAvantPause:null, etaApresReprise:null}
  let simLogLines = []

  function simLogLine(s){
    simLogLines.unshift('[' + simHHMM() + ' sim] ' + s)
    simLogLines = simLogLines.slice(0, 14)
    simRenderPanel()
  }

  function _nextPendingSimId(){
    return SIM_STOP_IDS.find(id => !validated[id] && !failed[id]) || null
  }
  function simEtaOf(id){
    return (typeof techETAs !== 'undefined' && id && techETAs[id]) ? techETAs[id].eta : null
  }

  function simStart(){
    if (simActive) { simLogLine('⚠️ simulation déjà en cours'); return }
    if (typeof tourRunning !== 'undefined' && tourRunning) {
      simLogLine('❌ un suivi de tournée réel est déjà actif sur cette page — recharge avec ?test=true seul, sans tournée réelle en cours')
      return
    }
    simSavedState = {
      techRouteLegDurations: techRouteLegDurations,
      _routeOrderedPts: _routeOrderedPts,
    }
    const pts = SIM_STOP_IDS.map((id, idx) => ({
      iv: {id, client:SIM_WAYPOINTS[idx+1].label, addr:'Adresse fictive — mode test', timeStart:null, type:'maintenance_simple', form:false},
      c: {lat:SIM_WAYPOINTS[idx+1].lat, lng:SIM_WAYPOINTS[idx+1].lng},
    }))
    techRouteLegDurations = SIM_LEGS
    _routeOrderedPts = pts
    simGpsIdx = 0
    simGpsPaused = false

    tourRunning = true
    tourStartTime = new Date() // lit l'horloge simulée patchée
    if (typeof _arrivalAlerted !== 'undefined') _arrivalAlerted = true // coupe l'alerte d'arrivée RÉELLE par sécurité — l'arrivée simulée est gérée par simNext()/ce fichier, jamais par _checkArrival()/endTournee() réels

    simActive = true
    simLog = {demarrage:simHHMM(), pause:null, dureePause:null, reprise:null, etaAvantPause:null, etaApresReprise:null}

    _startTourInterval()
    refreshLiveETAs()
    startLiveETAs()
    simLogLine('▶ démarrage simulé à ' + simLog.demarrage)
  }

  function simNext(){
    if (!simActive) return
    if (simGpsIdx >= 1 && simGpsIdx <= 3) validated[SIM_STOP_IDS[simGpsIdx - 1]] = true
    simGpsProgress = 0
    if (simGpsIdx < SIM_WAYPOINTS.length - 1) {
      simGpsIdx++
      simLogLine('➡ passage au point suivant : ' + SIM_WAYPOINTS[simGpsIdx].label)
    } else {
      simLogLine('🏁 arrivée simulée au point final')
    }
    refreshLiveETAs()
  }

  function simSetProgress(frac){
    simGpsProgress = Math.max(0, Math.min(1, Number(frac) || 0))
    simLogLine('📍 position simulée : ' + Math.round(simGpsProgress * 100) + '% du trajet vers ' + (SIM_WAYPOINTS[Math.min(simGpsIdx + 1, SIM_WAYPOINTS.length - 1)] || {}).label)
  }
  function simSetGpsSpeed(kmh){
    simGpsEtaSpeedKmh = Math.max(1, Number(kmh) || 40)
    simLogLine('🚗 vitesse GPS simulée réglée à ' + simGpsEtaSpeedKmh + ' km/h')
  }

  function simPause(){
    if (!simActive || simGpsPaused) return
    simGpsPaused = true
    if (typeof pauseTournee === 'function') pauseTournee() // fonction réelle (tech.html) — mémorise l'heure de pause
    simLog.pause = simHHMM()
    simLog.etaAvantPause = simEtaOf(_nextPendingSimId())
    simLogLine('⏸ pause à ' + simLog.pause + ' — ETA avant pause : ' + (simLog.etaAvantPause || '—'))
  }

  function simResume(){
    if (!simActive || !simGpsPaused) return
    simGpsPaused = false
    if (typeof resumeTournee === 'function') resumeTournee() // fonction réelle (tech.html) — cumule la durée de pause et recalcule les ETA
    simLog.reprise = simHHMM()
    const p = _hhmmToMin(simLog.pause), r = _hhmmToMin(simLog.reprise)
    simLog.dureePause = (p != null && r != null) ? (r - p) : null
    refreshLiveETAs()
    simLog.etaApresReprise = simEtaOf(_nextPendingSimId())
    simLogLine('▶ reprise à ' + simLog.reprise + ' (pause ' + simLog.dureePause + ' min) — ETA après reprise : ' + (simLog.etaApresReprise || '—'))
  }

  function simEnd(){
    if (!simActive) return
    clearInterval(tourTimer)
    navigator.geolocation.clearWatch(SIM_WATCH_ID)
    tourRunning = false
    tourStartTime = null
    SIM_STOP_IDS.forEach(id => { delete validated[id]; delete failed[id]; delete techETAs[id] })
    if (simSavedState) {
      techRouteLegDurations = simSavedState.techRouteLegDurations
      _routeOrderedPts = simSavedState._routeOrderedPts
    }
    simActive = false
    simGpsPaused = false
    simLogLine('■ fin de simulation — état réel restauré')
    if (typeof renderDepart === 'function') { try { renderDepart() } catch(e) { simLogLine('⚠️ renderDepart() a levé une erreur : ' + e.message) } }
  }

  // ─────────────────────────── Scénarios automatiques ──────────────────────
  // Chaque scénario réinitialise, démarre, avance de 10 min (en route vers le
  // 1er client), relève l'ETA, applique 0/1/2 pause(s) via jumpMinutes (saut
  // instantané de l'horloge simulée, pas d'attente réelle), relève l'ETA
  // après reprise, puis compare le décalage OBSERVÉ vs le décalage ATTENDU
  // (= durée de la pause). Ne corrige rien : consigne un "BUG DÉTECTÉ" si
  // les deux ne correspondent pas.
  function runScenario(def){
    if (simActive) simEnd()
    setSimClockMs(_defaultVirtualStart())
    simStart()
    jumpMinutes(10) // 09:10 — en route vers le premier client
    refreshLiveETAs()
    const etaBefore = simEtaOf(_nextPendingSimId())

    let etaAfterFirstPause = null, etaAfterSecondPause = null, etaAfterNext = null

    if (def.pauseMin > 0) {
      simPause()
      jumpMinutes(def.pauseMin)
      simResume()
      etaAfterFirstPause = simEtaOf(_nextPendingSimId())
    }
    if (def.secondPauseMin) {
      simPause()
      jumpMinutes(def.secondPauseMin)
      simResume()
      etaAfterSecondPause = simEtaOf(_nextPendingSimId())
    }
    if (def.thenNextClient) {
      simNext()
      etaAfterNext = simEtaOf(_nextPendingSimId())
    }

    const finalEta = etaAfterSecondPause || etaAfterFirstPause || etaBefore
    const totalPause = (def.pauseMin || 0) + (def.secondPauseMin || 0)
    const beforeMin = _hhmmToMin(etaBefore), afterMin = _hhmmToMin(finalEta)
    const decalageObserve = (beforeMin != null && afterMin != null) ? (afterMin - beforeMin) : null
    const bug = totalPause > 0 && decalageObserve !== totalPause

    const result = {
      test: def.name,
      pauseMin: def.pauseMin || 0,
      secondPauseMin: def.secondPauseMin || 0,
      etaAvant: etaBefore,
      etaApres: finalEta,
      etaApresClientSuivant: etaAfterNext,
      decalageAttendu: totalPause,
      decalageObserve,
      bug,
    }
    simEnd()
    return result
  }

  const SCENARIOS = [
    {name:'TEST 1 — démarrage sans pause', pauseMin:0},
    {name:'TEST 2 — pause 5 min', pauseMin:5},
    {name:'TEST 3 — pause 15 min', pauseMin:15},
    {name:'TEST 4 — pause 30 min', pauseMin:30},
    {name:'TEST 5 — deux pauses successives (10+10 min)', pauseMin:10, secondPauseMin:10},
    {name:'TEST 6 — pause 15 min puis passage au client suivant', pauseMin:15, thenNextClient:true},
  ]

  function runAllScenarios(){
    const results = SCENARIOS.map(runScenario)
    console.table(results)
    results.forEach(r => {
      const line = r.bug
        ? ('🔴 BUG — ' + r.test + ' : attendu +' + r.decalageAttendu + 'min, obtenu ' + (r.decalageObserve==null?'—':(r.decalageObserve>=0?'+':'')+r.decalageObserve+'min') + ' (ETA ' + r.etaAvant + ' → ' + r.etaApres + ')')
        : ('🟢 OK — ' + r.test + ' (ETA ' + r.etaAvant + ' → ' + r.etaApres + ')')
      simLogLine(line)
    })
    return results
  }

  // ─────────────────────────── Panneau DEBUG ────────────────────────────────
  function simRenderPanel(){
    let el = document.getElementById('sim-panel')
    if (!el) {
      el = document.createElement('div')
      el.id = 'sim-panel'
      el.style.cssText = 'position:fixed;top:8px;right:8px;width:310px;max-height:92vh;overflow-y:auto;background:rgba(15,15,15,.95);color:#7CFC00;font:11px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace;padding:10px;border-radius:10px;z-index:999999;box-shadow:0 4px 24px rgba(0,0,0,.6)'
      document.body.appendChild(el)
    }
    const realNow = new RealDate().toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit', second:'2-digit'})
    el.innerHTML =
      '<div style="color:#FFD54F;font-weight:700;margin-bottom:6px">🧪 MODE TEST — ne jamais utiliser en tournée réelle</div>' +
      '<div>Heure réelle : ' + realNow + '</div>' +
      '<div>Heure simulée : <b>' + simHHMM() + '</b> (×' + simSpeed + ')</div>' +
      '<div style="margin:8px 0;display:flex;gap:4px;flex-wrap:wrap">' +
        '<button onclick="OptiSim.start()"' + (simActive?' disabled':'') + '>Démarrer</button>' +
        '<button onclick="OptiSim.pause()"' + ((!simActive||simGpsPaused)?' disabled':'') + '>Pause</button>' +
        '<button onclick="OptiSim.resume()"' + ((!simActive||!simGpsPaused)?' disabled':'') + '>Reprise</button>' +
        '<button onclick="OptiSim.next()"' + (!simActive?' disabled':'') + '>Suivant</button>' +
        '<button onclick="OptiSim.end()"' + (!simActive?' disabled':'') + '>Fin</button>' +
      '</div>' +
      '<div style="margin:6px 0;border-top:1px solid #333;padding-top:6px">' +
        '<div>Démarrage : ' + (simLog.demarrage||'—') + '</div>' +
        '<div>Pause : ' + (simLog.pause||'—') + '</div>' +
        '<div>Durée pause : ' + (simLog.dureePause!=null ? simLog.dureePause+' min' : '—') + '</div>' +
        '<div>Reprise : ' + (simLog.reprise||'—') + '</div>' +
        '<div>ETA avant pause : ' + (simLog.etaAvantPause||'—') + '</div>' +
        '<div>ETA après reprise : ' + (simLog.etaApresReprise||'—') + '</div>' +
      '</div>' +
      '<div style="margin:6px 0;border-top:1px solid #333;padding-top:6px;display:flex;gap:6px;align-items:center">' +
        '<select onchange="OptiSim.setSpeed(this.value)">' +
          '<option value="1">×1 (temps réel)</option>' +
          '<option value="10">×10</option>' +
          '<option value="60" selected>×60 (1s=1min)</option>' +
          '<option value="300">×300</option>' +
        '</select>' +
      '</div>' +
      '<div style="margin:6px 0"><button onclick="OptiSim.runAllScenarios()">▶ Lancer TEST 1 à 6</button></div>' +
      '<div style="margin-top:6px;border-top:1px solid #333;padding-top:6px;max-height:220px;overflow-y:auto">' +
        simLogLines.map(l => '<div>' + l.replace(/</g,'&lt;') + '</div>').join('') +
      '</div>'
  }
  setInterval(simRenderPanel, 1000)

  window.OptiSim = {
    start: simStart, pause: simPause, resume: simResume, next: simNext, end: simEnd,
    setSpeed: setSimSpeed, jumpMinutes, runAllScenarios, runScenario,
    setProgress: simSetProgress, setGpsSpeed: simSetGpsSpeed,
    _debug: () => ({simActive, simLog, simGpsIdx, simGpsProgress, simGpsEtaSpeedKmh, techRouteLegDurations, _routeOrderedPts}),
  }

  document.addEventListener('DOMContentLoaded', simRenderPanel)
  simRenderPanel()
  console.log('%c🧪 OptiTechX — mode test activé (?test=true). Panneau en haut à droite. window.OptiSim expose les contrôles.', 'color:#FFD54F;font-weight:bold')
})()
