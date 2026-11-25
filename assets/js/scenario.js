/* ==========================================================================
   scenario.js — Génère les étapes d'une simulation à partir d'une config.
   Une même fonction sert aux scénarios guidés ET au labo de dépannage :
   le comportement (diffusion, tag/détag, routage, pannes) découle
   réellement de la configuration choisie.
   ========================================================================== */
'use strict';

/* ---------- Constructeurs de trames ---------- */
function frameArp(op, srcMac, dstMac, spa, tpa, tha, vlan) {
  return {
    proto: 'ARP', vlan, tag: null, dst: dstMac, src: srcMac, type: '0x0806',
    arp: { op, sha: srcMac, spa, tha, tpa },
  };
}
function frameIcmp(kind, srcMac, dstMac, ipSrc, ipDst, ttl, vlan) {
  return {
    proto: 'ICMP', vlan, tag: null, dst: dstMac, src: srcMac, type: '0x0800',
    ip: { src: ipSrc, dst: ipDst, ttl, icmp: kind },
  };
}
const withTag = (f, v) => ({ ...f, tag: v, vlan: v });
const noTag = (f) => ({ ...f, tag: null });
const mv = (from, to, frame) => ({ from, to, frame });

/* ---------- Effets sur l'état des équipements ---------- */
const fxMac = (vlan, mac, port) => ({ t: 'mac', vlan, mac, port });
const fxArp = (dev, ip, mac, itf) => ({ t: 'arp', dev, ip, mac, itf });

const c = (s) => `<code>${s}</code>`;
const vl = (v) => `<span class="vchip v${v}">VLAN ${v}</span>`;

/**
 * @param {object} cfg  { p1, p2, allowed:[], subs:[] }
 * @param {object} opts { arp:bool, arpOnly:bool, reply:bool }
 * @returns {Array} étapes
 */
function buildScenarioCore(cfg, opts) {
  const { pc1, pc2, r } = NET;
  const v1 = cfg.p1;
  const v2 = cfg.p2;
  const onTrunk = (v) => cfg.allowed.includes(v);
  const hasSub = (v) => cfg.subs.includes(v);
  const S = [];
  let trunkCrossings = 0;

  const fail = (title, html, fix, extra = {}) => {
    S.push({
      phase: 'Résultat', status: 'fail', title, ...extra,
      html: `${html}<div class="fix"><strong>Correctif :</strong><pre>${fix}</pre></div>`,
    });
    return S;
  };

  /* ---------------- 0. Point de départ ---------------- */
  const intro = {
    phase: 'Départ', title: 'PC1 veut joindre PC2', focus: ['pc1'],
    notes: [{ at: 'pc1', text: `ping ${pc2.ip}` }],
    html: `<p>PC1 (${c(pc1.ip + '/24')}) lance un ${c('ping ' + pc2.ip)}.</p>
      <p>Il applique son masque : ${c('192.168.10.0')} ≠ ${c('192.168.20.0')}. PC2 est <strong>hors de son réseau</strong>,
      donc PC1 doit passer par sa <strong>passerelle par défaut</strong> ${c(pc1.gw)}, c'est-à-dire la sous-interface
      ${c('G0/0.10')} du routeur.</p>
      <p class="muted">Rappel : PC1 et PC2 sont branchés sur le <em>même</em> switch, mais dans deux VLAN différents.
      Pour eux, c'est comme s'ils étaient sur deux switchs séparés.</p>`,
    effects: [],
  };
  if (!opts.arp) {
    intro.html += `<p class="muted">Dans ce scénario, on suppose que les tables ARP et MAC sont déjà remplies
      (un premier ping a déjà eu lieu). On se concentre sur le trajet du paquet et sur les tags 802.1Q.</p>`;
    intro.effects = [
      fxMac(10, pc1.mac, 'Fa0/1'), fxMac(10, r.mac, 'Gi0/1'),
      fxMac(20, pc2.mac, 'Fa0/2'), fxMac(20, r.mac, 'Gi0/1'),
      fxArp('pc1', pc1.gw, r.mac, 'eth0'), fxArp('pc2', pc2.gw, r.mac, 'eth0'),
      fxArp('r', pc1.ip, pc1.mac, 'G0/0.10'), fxArp('r', pc2.ip, pc2.mac, 'G0/0.20'),
    ];
  }
  S.push(intro);

  /* ---------------- 1. ARP : PC1 cherche la MAC de sa passerelle ---------------- */
  if (opts.arp) {
    const req = frameArp('request', pc1.mac, NET.bcast, pc1.ip, pc1.gw, '00:00:00:00:00:00', v1);
    S.push({
      phase: 'ARP', title: 'PC1 diffuse une requête ARP',
      moves: [mv('pc1', 'sw', req)],
      notes: [{ at: 'pc1', text: `Qui a ${pc1.gw} ?` }],
      effects: [fxMac(v1, pc1.mac, 'Fa0/1')],
      html: `<p>PC1 ne connaît pas l'adresse MAC de sa passerelle. Il envoie une <strong>requête ARP en broadcast</strong>
        (MAC destination ${c(NET.bcast)}) : « Qui a ${c(pc1.gw)} ? Répondez à ${c(pc1.ip)} ».</p>
        <p>La trame sort de PC1 <strong>sans tag</strong> : un PC ignore tout des VLAN.</p>
        <p>En entrant sur le port ${c('Fa0/1')} (access ${vl(v1)}), le switch associe la trame au ${vl(v1)}
        et <strong>apprend</strong> la MAC de PC1 sur ce port, dans ce VLAN.</p>`,
    });

    const moves = [];
    const blocks = [];
    const notes = [];
    if (v2 === v1) moves.push(mv('sw', 'pc2', noTag(req)));
    else blocks.push({ link: 'sw-pc2', text: `VLAN ${v2} ≠ ${v1}` });
    if (onTrunk(v1)) { moves.push(mv('sw', 'r', withTag(req, v1))); trunkCrossings++; notes.push({ at: 'sw', text: `+ tag 802.1Q VID ${v1}` }); }
    else blocks.push({ link: 'r-sw', text: `VLAN ${v1} non autorisé` });

    let html = `<p>Un broadcast est diffusé sur <strong>tous les ports du même VLAN</strong> (sauf le port d'entrée), et seulement eux.</p><ul>`;
    html += v2 === v1
      ? `<li>${c('Fa0/2')} est aussi en ${vl(v1)} → PC2 reçoit la trame (non taguée).</li>`
      : `<li>${c('Fa0/2')} est en ${vl(v2)} → <strong>PC2 ne reçoit rien</strong>. C'est l'isolation : chaque VLAN est un domaine de broadcast distinct.</li>`;
    html += onTrunk(v1)
      ? `<li>${c('Gi0/1')} est un <strong>trunk</strong> qui transporte le ${vl(v1)} → la trame y part, mais le switch y
          <strong>insère un tag 802.1Q</strong> (VID ${v1}) pour que l'autre extrémité sache à quel VLAN elle appartient.</li>`
      : `<li>${c('Gi0/1')} est un trunk, mais le ${vl(v1)} <strong>n'est pas dans sa liste autorisée</strong>
          (${c('allowed vlan ' + cfg.allowed.join(','))}) → la trame n'y est pas envoyée.</li>`;
    html += '</ul>';
    S.push({ phase: 'ARP', title: 'Le switch diffuse… dans le VLAN uniquement', focus: ['sw'], moves, blocks, notes, html });

    if (v2 === v1) {
      S.push({
        phase: 'ARP', title: 'PC2 ignore la requête', focus: ['pc2'],
        notes: [{ at: 'pc2', text: `${pc1.gw} ? Pas moi.` }],
        html: `<p>PC2 reçoit le broadcast car il est dans le même VLAN, mais l'adresse demandée (${c(pc1.gw)})
          n'est pas la sienne : il l'ignore. Rien de grave ici, mais PC2 subit le trafic de diffusion d'un VLAN
          qui n'est pas le sien… et cela révélera un vrai problème plus loin.</p>`,
      });
    }

    if (!onTrunk(v1)) {
      return fail('Échec : la requête ARP ne quitte jamais le switch',
        `<p>Le ${vl(v1)} n'étant pas autorisé sur le trunk, la requête n'atteint jamais le routeur. PC1 n'obtient pas de
         réponse ARP : le ping échoue avec <em>« Délai d'attente de la demande dépassé »</em>.</p>`,
        `SW1(config)# interface GigabitEthernet0/1\nSW1(config-if)# switchport trunk allowed vlan add ${v1}`,
        { focus: ['sw'], blocks: [{ link: 'r-sw', text: `VLAN ${v1} bloqué` }] });
    }

    if (!hasSub(v1)) {
      return fail('Échec : aucune sous-interface pour ce VLAN',
        `<p>La trame taguée VID ${v1} arrive sur ${c('G0/0')}, mais aucune sous-interface n'a ${c('encapsulation dot1Q ' + v1)}.
         Le routeur ne sait pas à quelle interface logique la rattacher : il la <strong>jette</strong>.</p>`,
        `R1(config)# interface GigabitEthernet0/0.${v1}\nR1(config-subif)# encapsulation dot1Q ${v1}\nR1(config-subif)# ip address ${NET.vlans[v1].gw} 255.255.255.0`,
        { focus: ['r'], drops: [{ at: 'r', text: `Pas de G0/0.${v1}` }] });
    }

    if (NET.vlans[v1].gw !== pc1.gw) {
      return fail('Échec : incohérence VLAN / adressage IP',
        `<p>La trame arrive sur ${c('G0/0.' + v1)}, dont l'adresse est ${c(NET.vlans[v1].gw)}. Or PC1 demande ${c(pc1.gw)} :
         le routeur ne répond pas, ce n'est pas son adresse sur ce VLAN.</p>
         <p>PC1 est adressé en ${c('192.168.10.0/24')} mais son port est dans le ${vl(v1)}. Le VLAN du port et le plan
         d'adressage doivent correspondre.</p>`,
        `SW1(config)# interface FastEthernet0/1\nSW1(config-if)# switchport access vlan 10`,
        { focus: ['r'], notes: [{ at: 'r', text: `${pc1.gw} ? Pas ici.` }] });
    }

    S.push({
      phase: 'ARP', title: `Le routeur reçoit sur G0/0.${v1}`, focus: ['r'],
      notes: [{ at: 'r', text: `VID ${v1} → G0/0.${v1}` }],
      effects: [fxArp('r', pc1.ip, pc1.mac, `G0/0.${v1}`)],
      html: `<p>Une seule interface physique, ${c('G0/0')}, mais plusieurs <strong>sous-interfaces</strong>. Le routeur lit le
        VID du tag (${v1}) et remet la trame à la sous-interface configurée avec ${c('encapsulation dot1Q ' + v1)},
        c'est-à-dire ${c('G0/0.' + v1)}.</p>
        <p>L'adresse demandée (${c(pc1.gw)}) est bien la sienne : il note PC1 dans sa table ARP et prépare la réponse.</p>`,
    });

    const rep = frameArp('reply', r.mac, pc1.mac, pc1.gw, pc1.ip, pc1.mac, v1);
    trunkCrossings++;
    S.push({
      phase: 'ARP', title: 'Réponse ARP taguée sur le trunk',
      moves: [mv('r', 'sw', withTag(rep, v1))],
      effects: [fxMac(v1, r.mac, 'Gi0/1')],
      html: `<p>La réponse est en <strong>unicast</strong> vers la MAC de PC1. Comme elle sort par ${c('G0/0.' + v1)},
        le routeur y ajoute lui-même le tag <strong>VID ${v1}</strong>.</p>
        <p>À l'arrivée sur ${c('Gi0/1')}, le switch lit le tag et apprend la MAC du routeur
        (${c(r.mac)}) dans le ${vl(v1)}, sur le port trunk.</p>`,
    });

    S.push({
      phase: 'ARP', title: 'Le switch retire le tag et livre à PC1',
      moves: [mv('sw', 'pc1', rep)],
      notes: [{ at: 'sw', text: `− tag ${v1}` }, { at: 'pc1', text: `${pc1.gw} = ${r.mac.slice(-5)}` }],
      effects: [fxArp('pc1', pc1.gw, r.mac, 'eth0')],
      html: `<p>Le switch cherche ${c(pc1.mac)} dans sa table MAC <strong>du ${vl(v1)}</strong> → port ${c('Fa0/1')}.</p>
        <p>C'est un port <strong>access</strong> : le switch <strong>retire le tag</strong> avant d'envoyer la trame. PC1 reçoit une trame
        Ethernet ordinaire et enregistre la MAC de sa passerelle dans son cache ARP.</p>`,
    });

    if (opts.arpOnly) {
      S.push({
        phase: 'Bilan', status: 'success', title: 'Bilan : le broadcast est resté dans son VLAN', focus: ['pc1', 'r'],
        html: `<ul>
          <li>Le broadcast de PC1 n'a <strong>jamais atteint PC2</strong> : un VLAN = un domaine de broadcast.</li>
          <li>Sur le <strong>port access</strong>, les trames circulent sans tag ; sur le <strong>trunk</strong>, elles portent un tag 802.1Q.</li>
          <li>Le switch a appris deux MAC dans le VLAN 10 : PC1 sur ${c('Fa0/1')}, le routeur sur ${c('Gi0/1')}.</li>
          <li>PC1 connaît maintenant la MAC de sa passerelle : il peut envoyer son ping.</li></ul>
          <p class="muted">Enchaînez avec le scénario « Ping inter-VLAN » pour voir la suite.</p>`,
      });
      return S;
    }
  }

  /* ---------------- 2. ICMP Echo Request PC1 → routeur ---------------- */
  const icmpReq = frameIcmp('echo-request', pc1.mac, r.mac, pc1.ip, pc2.ip, 64, v1);
  S.push({
    phase: 'Ping aller', title: 'PC1 envoie le ping… à la MAC du routeur',
    moves: [mv('pc1', 'sw', icmpReq)],
    html: `<p>Point clé : dans la trame, <strong>l'IP de destination est celle de PC2</strong> (${c(pc2.ip)}),
      mais <strong>la MAC de destination est celle du routeur</strong> (${c(r.mac)}).</p>
      <p>En couche 2, PC1 ne peut parler qu'à sa passerelle ; c'est elle qui fera sortir le paquet du VLAN.
      La trame reste <strong>non taguée</strong> sur le lien access.</p>`,
  });

  trunkCrossings++;
  S.push({
    phase: 'Ping aller', title: `Montée sur le trunk avec le tag ${v1}`,
    moves: [mv('sw', 'r', withTag(icmpReq, v1))],
    notes: [{ at: 'sw', text: `+ tag VID ${v1}` }],
    html: `<p>Le switch cherche ${c(r.mac)} dans sa table MAC du ${vl(v1)} → port ${c('Gi0/1')} (trunk).
      Il n'inonde pas : c'est de l'unicast connu.</p>
      <p>Il <strong>insère le tag 802.1Q</strong> (4 octets entre la MAC source et l'EtherType : TPID ${c('0x8100')} + VID ${v1})
      et recalcule le FCS. La trame passe de 1514 à 1518 octets au maximum (hors FCS).</p>`,
  });

  if (!hasSub(20)) {
    return fail('Échec : le routeur ne connaît pas 192.168.20.0/24',
      `<p>Le routeur reçoit bien le paquet sur ${c('G0/0.10')}, mais sans sous-interface ${c('G0/0.20')}, aucune route
       vers ${c('192.168.20.0/24')} n'existe dans sa table. Il jette le paquet et renvoie un
       <em>ICMP Destination Unreachable</em> à PC1.</p>`,
      `R1(config)# interface GigabitEthernet0/0.20\nR1(config-subif)# encapsulation dot1Q 20\nR1(config-subif)# ip address 192.168.20.1 255.255.255.0`,
      { focus: ['r'], drops: [{ at: 'r', text: 'Pas de route' }] });
  }

  S.push({
    phase: 'Routage', title: 'Le routeur route du VLAN 10 vers le VLAN 20', focus: ['r'],
    notes: [{ at: 'r', text: 'TTL 64 → 63 · .10 → .20' }],
    html: `<p>Sur ${c('G0/0.10')}, le routeur <strong>retire le tag</strong> et décapsule : MAC destination = la sienne,
      donc il examine le paquet IP.</p>
      <ol><li>IP destination ${c(pc2.ip)} → table de routage : ${c('C 192.168.20.0/24 via G0/0.20')} (directement connecté).</li>
      <li>Il décrémente le <strong>TTL</strong> : 64 → 63.</li>
      <li>Il <strong>réécrit l'en-tête Ethernet</strong> : MAC source = la sienne, MAC destination = celle de PC2.</li>
      <li>Comme il sort par ${c('G0/0.20')}, il ajoutera le tag <strong>VID 20</strong>.</li></ol>
      <p class="muted">Les adresses IP ne changent pas de bout en bout ; les adresses MAC, elles, changent à chaque saut.</p>`,
  });

  /* ---- ARP du routeur vers PC2 ---- */
  if (opts.arp) {
    const rReq = frameArp('request', r.mac, NET.bcast, NET.vlans[20].gw, pc2.ip, '00:00:00:00:00:00', 20);
    trunkCrossings++;
    S.push({
      phase: 'ARP (R1)', title: 'Le routeur cherche la MAC de PC2',
      moves: [mv('r', 'sw', withTag(rReq, 20))],
      notes: [{ at: 'r', text: `Qui a ${pc2.ip} ?` }],
      html: `<p>Le routeur ne connaît pas encore la MAC de PC2. Il met le ping en attente et envoie une requête ARP en
        broadcast par ${c('G0/0.20')}, donc <strong>taguée VID 20</strong>.</p>
        <p>Remarquez : c'est le <strong>même câble</strong> que tout à l'heure, mais un autre VLAN. C'est tout l'intérêt du trunk.</p>`,
    });

    if (!onTrunk(20)) {
      return fail('Échec : le switch rejette les trames du VLAN 20',
        `<p>Le routeur envoie une trame taguée VID 20, mais le VLAN 20 n'est pas autorisé sur ${c('Gi0/1')}
         (${c('allowed vlan ' + cfg.allowed.join(','))}). Le switch <strong>jette la trame</strong> en entrée.</p>
         <p>Symptôme typique : le routeur a bien son interface ${c('G0/0.20')} « up/up », mais rien ne passe dans ce VLAN.
         ${c('show interfaces trunk')} révèle la liste autorisée.</p>`,
        `SW1(config)# interface GigabitEthernet0/1\nSW1(config-if)# switchport trunk allowed vlan add 20`,
        { focus: ['sw'], drops: [{ at: 'sw-top', text: 'VLAN 20 refusé' }] });
    }

    const fmoves = [];
    const fblocks = [];
    if (v2 === 20) fmoves.push(mv('sw', 'pc2', noTag(rReq)));
    else fblocks.push({ link: 'sw-pc2', text: `PC2 en VLAN ${v2}` });
    if (v1 === 20) fmoves.push(mv('sw', 'pc1', noTag(rReq)));
    else fblocks.push({ link: 'sw-pc1', text: 'VLAN 10 ≠ 20' });

    S.push({
      phase: 'ARP (R1)', title: 'Diffusion dans le VLAN 20', focus: ['sw'],
      moves: fmoves, blocks: fblocks,
      notes: [{ at: 'sw', text: '− tag 20' }],
      effects: [fxMac(20, r.mac, 'Gi0/1')],
      html: `<p>Le switch lit le tag (VID 20), apprend la MAC du routeur <strong>dans le VLAN 20</strong> (la même MAC est
        maintenant connue dans deux VLAN, sur le même port), puis diffuse sur les ports access du VLAN 20, sans le tag.</p>
        ${v2 === 20
          ? `<p>${c('Fa0/2')} est en ${vl(20)} → PC2 reçoit la requête. ${c('Fa0/1')} (${vl(10)}) est épargné.</p>`
          : `<p><strong>Aucun port access n'est dans le VLAN 20</strong> : ${c('Fa0/2')} est en ${vl(v2)}. La requête ne trouve personne.</p>`}`,
    });

    if (v2 !== 20) {
      return fail('Échec : PC2 est dans le mauvais VLAN',
        `<p>PC2 est adressé en ${c('192.168.20.0/24')} mais son port ${c('Fa0/2')} est en ${vl(v2)}. La requête ARP du
         routeur (VLAN 20) ne lui parvient jamais : le routeur ne peut pas livrer le ping.</p>
         <p>C'est une panne fréquente : le câble est bon et la LED est verte, mais le port est affecté au mauvais VLAN.</p>`,
        `SW1(config)# interface FastEthernet0/2\nSW1(config-if)# switchport access vlan 20`,
        { focus: ['pc2'], blocks: [{ link: 'sw-pc2', text: `VLAN ${v2} ≠ 20` }] });
    }

    const p2Rep = frameArp('reply', pc2.mac, r.mac, pc2.ip, NET.vlans[20].gw, r.mac, 20);
    S.push({
      phase: 'ARP (R1)', title: 'PC2 répond au routeur',
      moves: [mv('pc2', 'sw', p2Rep)],
      notes: [{ at: 'pc2', text: `${pc2.ip} = moi !` }],
      effects: [fxMac(20, pc2.mac, 'Fa0/2'), fxArp('pc2', NET.vlans[20].gw, r.mac, 'eth0')],
      html: `<p>PC2 reconnaît son adresse. Il en profite pour noter la MAC de ${c('192.168.20.1')} (sa passerelle),
        puis répond en unicast, <strong>sans tag</strong>. Le switch apprend PC2 sur ${c('Fa0/2')}, VLAN 20.</p>`,
    });
    trunkCrossings++;
    S.push({
      phase: 'ARP (R1)', title: 'La réponse remonte, taguée 20',
      moves: [mv('sw', 'r', withTag(p2Rep, 20))],
      notes: [{ at: 'sw', text: '+ tag VID 20' }],
      effects: [fxArp('r', pc2.ip, pc2.mac, 'G0/0.20')],
      html: `<p>Destination : la MAC du routeur, connue dans le VLAN 20 sur ${c('Gi0/1')}. Le switch ajoute le tag 20 ;
        le routeur la reçoit sur ${c('G0/0.20')} et complète sa table ARP. Il peut maintenant relâcher le ping.</p>`,
    });
  }

  /* ---- Le ping redescend vers PC2 ---- */
  const icmpFwd = frameIcmp('echo-request', r.mac, pc2.mac, pc1.ip, pc2.ip, 63, 20);
  trunkCrossings++;
  S.push({
    phase: 'Ping aller', title: 'Le ping redescend le trunk, tagué 20',
    moves: [mv('r', 'sw', withTag(icmpFwd, 20))],
    html: `<p>Même câble, sens inverse, autre VLAN : la trame sort de ${c('G0/0.20')} avec le tag <strong>VID 20</strong>.</p>
      <p>Comparez avec l'étape où le ping est monté : la MAC source est maintenant celle du routeur, la MAC destination celle de PC2,
      le TTL vaut 63… et les IP n'ont pas bougé.</p>
      <p class="muted">Ce va-et-vient sur un seul lien explique le surnom « router-on-a-stick » : le trafic inter-VLAN
      traverse deux fois le trunk.</p>`,
  });

  S.push({
    phase: 'Ping aller', title: 'Le tag est retiré, PC2 reçoit le ping',
    moves: [mv('sw', 'pc2', icmpFwd)],
    notes: [{ at: 'sw', text: '− tag 20' }, { at: 'pc2', text: 'Echo Request reçu' }],
    html: `<p>Table MAC du ${vl(20)} : ${c(pc2.mac)} → ${c('Fa0/2')}, un port access. Le switch <strong>retire le tag</strong> :
      PC2 reçoit une trame ordinaire, sans savoir qu'elle a voyagé dans un trunk.</p>`,
  });

  if (!opts.reply) return S;

  /* ---------------- 3. Retour : Echo Reply ---------------- */
  const rep1 = frameIcmp('echo-reply', pc2.mac, r.mac, pc2.ip, pc1.ip, 64, 20);
  S.push({
    phase: 'Ping retour', title: 'PC2 répond via sa passerelle',
    moves: [mv('pc2', 'sw', rep1)],
    html: `<p>PC2 renvoie un <strong>Echo Reply</strong> vers ${c(pc1.ip)}. Ce n'est pas son réseau : il l'adresse à la MAC de
      sa passerelle ${c('192.168.20.1')}, c'est-à-dire au routeur. La trame est non taguée.</p>`,
  });
  trunkCrossings++;
  S.push({
    phase: 'Ping retour', title: 'Montée sur le trunk (VID 20)',
    moves: [mv('sw', 'r', withTag(rep1, 20))],
    notes: [{ at: 'sw', text: '+ tag VID 20' }],
    html: `<p>Le switch associe la trame au VLAN 20 (port ${c('Fa0/2')}), trouve la MAC du routeur sur ${c('Gi0/1')}
      et ajoute le tag 20.</p>`,
  });
  S.push({
    phase: 'Routage', title: 'Routage retour : du VLAN 20 vers le VLAN 10', focus: ['r'],
    notes: [{ at: 'r', text: 'TTL 64 → 63 · .20 → .10' }],
    html: `<p>Reçu sur ${c('G0/0.20')} → destination ${c(pc1.ip)} → route ${c('C 192.168.10.0/24 via G0/0.10')}.
      TTL décrémenté, en-tête Ethernet réécrit (MAC destination = PC1, déjà dans la table ARP), tag VID 10.</p>`,
  });
  const rep2 = frameIcmp('echo-reply', r.mac, pc1.mac, pc2.ip, pc1.ip, 63, 10);
  trunkCrossings++;
  S.push({
    phase: 'Ping retour', title: 'Descente sur le trunk (VID 10)',
    moves: [mv('r', 'sw', withTag(rep2, 10))],
    html: `<p>La réponse redescend le trunk, cette fois taguée <strong>VID 10</strong>.</p>`,
  });
  S.push({
    phase: 'Ping retour', title: 'PC1 reçoit la réponse',
    moves: [mv('sw', 'pc1', rep2)],
    notes: [{ at: 'sw', text: '− tag 10' }, { at: 'pc1', text: 'Réponse de 192.168.20.10 : TTL=63' }],
    html: `<p>Le switch retire le tag et livre sur ${c('Fa0/1')}. PC1 affiche :
      ${c('Réponse de 192.168.20.10 : octets=32 temps&lt;1ms TTL=63')}</p>
      <p class="muted">Le TTL de 63 trahit le passage par un routeur (64 − 1).</p>`,
  });

  S.push({
    phase: 'Bilan', status: 'success', title: 'Ping réussi : bilan', focus: ['pc1', 'pc2'],
    html: `<ul>
      <li>Les PC n'ont jamais vu un seul tag : <strong>le tag n'existe que sur le trunk</strong>.</li>
      <li>Le câble unique entre SW1 et R1 a été traversé <strong>${trunkCrossings} fois</strong>, tantôt en VLAN 10, tantôt en VLAN 20.</li>
      <li>Le switch seul ne peut pas faire passer une trame d'un VLAN à l'autre : il faut une fonction de <strong>routage (couche 3)</strong>.</li>
      <li>Les IP sont restées identiques de bout en bout ; les MAC et le TTL ont changé au passage du routeur.</li></ul>`,
  });
  return S;
}

/* ==========================================================================
   Trois niveaux de lecture
   - easy : Débutant (analogie, zéro jargon)
   - html : Intermédiaire (texte de référence)
   - pro  : Expert (complément technique ajouté au texte intermédiaire)
   ========================================================================== */
function buildScenario(cfg, opts) {
  const S = buildScenarioCore(cfg, opts);
  annotateLevels(S, cfg, opts);
  return S;
}

function annotateLevels(S, cfg, opts) {
  const v1 = cfg.p1;
  const v2 = cfg.p2;
  const trunkOk = cfg.allowed.includes(v1);
  const et = (v) => `<span class="vchip v${v}">étiquette VLAN ${v}</span>`;
  const salle = (v) => `la salle <strong>${v}</strong>`;

  const RULES = [
    ['PC1 veut joindre PC2', () => `<p>PC1 veut envoyer un message (un <em>ping</em>) à PC2.</p>
      <p>Imagine le switch comme un bâtiment avec <strong>deux salles fermées</strong> : ${salle(10)} (VLAN 10) et ${salle(20)} (VLAN 20).
      PC1 et PC2 ne sont pas dans la même salle : ils ne peuvent pas se parler directement.</p>
      <p>PC1 doit donc passer par le <strong>routeur</strong>, la seule « porte » entre les deux salles.</p>
      ${opts.arp ? '' : '<p class="muted">Dans ce scénario, PC1 connaît déjà l\'adresse du routeur : on va droit au but.</p>'}`,
     () => `<p><strong>Décision locale :</strong> (IP destination ET masque) ≠ (IP source ET masque) → envoi au next-hop = passerelle par défaut.
      Pour le vérifier : ${c('route print')} (Windows) ou ${c('ip route get 192.168.20.10')} (Linux).</p>`],

    ['PC1 diffuse une requête ARP', () => `<p>PC1 ne connaît pas encore l'adresse du routeur. Il crie dans sa salle :
      <strong>« Qui est le routeur ? »</strong></p>
      <p>Son message part <strong>sans étiquette</strong> : un PC ne sait même pas que les VLAN existent.</p>`,
     () => `<p>Trame de 60 octets minimum (avec bourrage), EtherType ${c('0x0806')}, opcode 1, adresse cible à zéro.
      L'entrée MAC est créée avec un vieillissement de 300 s par défaut (${c('mac address-table aging-time')}).</p>`],

    ['Le switch diffuse', () => `<p>Le switch répète le message <strong>uniquement dans ${salle(v1)}</strong>.</p>
      ${v2 === v1 ? '<p>PC2 est dans la même salle : il l\'entend aussi.</p>' : '<p>PC2 est dans l\'autre salle : <strong>il n\'entend rien</strong>. C\'est tout l\'intérêt des VLAN !</p>'}
      ${trunkOk ? `<p>Pour envoyer le message au routeur par le <strong>câble partagé</strong> (le trunk), le switch colle dessus une ${et(v1)}.</p>`
        : '<p>Mais le câble vers le routeur n\'accepte pas cette salle : le message ne peut pas y passer.</p>'}`,
     () => `<p>Inondation = ports membres du VLAN en état STP <em>forwarding</em>, sauf le port d'entrée. Sur le trunk : insertion du tag et
      recalcul du FCS. À vérifier avec ${c('show interfaces trunk')} et ${c('show spanning-tree vlan ' + v1)}.</p>`],

    ['PC2 ignore la requête', () => `<p>PC2 reçoit le message, mais ce n'est pas lui qu'on cherche : il l'ignore.</p>`, null],

    ['Le routeur reçoit sur', () => `<p>Le routeur lit l'${et(v1)} et sait que le message vient de ${salle(v1)}.</p>
      <p>C'est bien lui qu'on cherche : il va répondre.</p>`,
     () => `<p>Le VID sélectionne la sous-interface. L'entrée ARP est créée (expiration de 4 h par défaut sur IOS).
      Voir ${c('show arp')} et ${c('show interfaces g0/0.' + v1)}.</p>`],

    ['Réponse ARP taguée sur le trunk', () => `<p>Le routeur répond <strong>« C'est moi ! »</strong>. Sur le câble partagé, le message garde son ${et(v1)}.</p>`,
     () => `<p>Toutes les sous-interfaces partagent la MAC de l'interface physique. Le switch indexe sa table par couple (VLAN, MAC) :
      la même MAC peut donc exister dans plusieurs VLAN.</p>`],

    ['Le switch retire le tag et livre à PC1', () => `<p>Le switch <strong>enlève l'étiquette</strong> et donne la réponse à PC1.</p>
      <p>PC1 connaît maintenant l'adresse du routeur.</p>`,
     () => `<p>Recherche (VLAN ${v1}, MAC PC1) → ${c('Fa0/1')}, port access → retrait du tag. Côté PC : ${c('arp -a')}.</p>`],

    ['Bilan : le broadcast', () => `<p><strong>À retenir :</strong></p><ul>
      <li>Un message « à tout le monde » <strong>reste dans sa salle</strong> (son VLAN). PC2 ne l'a jamais reçu.</li>
      <li>L'étiquette n'existe que sur le <strong>câble partagé</strong> (le trunk). Les PC ne la voient jamais.</li></ul>`, null],

    ['PC1 envoie le ping', () => `<p>PC1 envoie son ping. Sur l'enveloppe, il est écrit <strong>« pour PC2 »</strong>,
      mais PC1 la confie <strong>au routeur</strong>, comme on confie une lettre au facteur.</p>`,
     () => `<p>IP destination = PC2, MAC destination = passerelle. ICMP type 8 avec identifiant et numéro de séquence ;
      Windows envoie 32 octets de données, Linux 56.</p>`],

    ['Montée sur le trunk avec', () => `<p>Le switch colle une ${et(10)} et envoie le ping au routeur par le câble partagé.</p>`,
     () => `<p>Unicast connu : pas d'inondation. Taille maximale 1522 octets FCS compris : certains équipements anciens
      exigent un MTU adapté (<em>baby giants</em>).</p>`],

    ['Le routeur route du VLAN 10 vers le VLAN 20', () => `<p>Le routeur enlève l'${et(10)}, voit que le ping est pour ${salle(20)},
      et prépare une nouvelle ${et(20)}.</p><p>C'est lui qui fait le <strong>pont entre les deux salles</strong>.</p>`,
     () => `<p>Plus long préfixe correspondant, puis commutation CEF : réécriture L2 depuis la table d'adjacence, TTL − 1,
      recalcul de la somme de contrôle IP. Voir ${c('show ip cef 192.168.20.10')}.</p>`],

    ['Le routeur cherche la MAC de PC2', () => `<p>Le routeur ne connaît pas encore PC2. Il crie dans ${salle(20)} :
      <strong>« Qui est PC2 ? »</strong>, avec une ${et(20)}, sur le même câble.</p>`,
     () => `<p>En réalité, IOS <strong>jette</strong> souvent le paquet en attente pendant la résolution ARP : c'est le « . » du célèbre
      ${c('.!!!!')} lors du premier ping depuis un routeur Cisco.</p>`],

    ['Diffusion dans le VLAN 20', () => (v2 === 20
      ? `<p>Le switch enlève l'étiquette et répète le message dans ${salle(20)} : PC2 l'entend. PC1, dans ${salle(10)}, n'entend rien.</p>`
      : `<p>Le switch répète le message dans ${salle(20)}… mais <strong>personne n'y est</strong> : PC2 est dans l'autre salle !</p>`),
     () => '<p>La MAC du routeur est apprise dans deux VLAN sur Gi0/1 : c\'est normal, la table MAC est indexée par VLAN.</p>'],

    ['PC2 répond au routeur', () => '<p>PC2 répond <strong>« C\'est moi ! »</strong> au routeur, sans étiquette.</p>', null],
    ['La réponse remonte', () => `<p>Le switch colle une ${et(20)} et remonte la réponse. Le routeur connaît maintenant PC2.</p>`, null],

    ['Le ping redescend le trunk', () => `<p>Le routeur renvoie le ping vers le switch avec une ${et(20)}.
      <strong>Même câble, dans l'autre sens !</strong></p>`,
     () => `<p>MAC source et destination réécrites, IP inchangées, TTL 63. Le trafic inter-VLAN consomme deux fois la bande passante
      du trunk : c'est la limite du router-on-a-stick.</p>`],

    ['Le tag est retiré, PC2 reçoit le ping', () => '<p>Le switch enlève l\'étiquette et donne le ping à PC2. <strong>Arrivé !</strong></p>', null],
    ['PC2 répond via sa passerelle', () => '<p>PC2 répond. Même chemin, en sens inverse : la réponse passe d\'abord par le routeur.</p>',
     () => '<p>ICMP type 0, même identifiant et même numéro de séquence que la requête : c\'est ainsi que PC1 associe la réponse à sa question.</p>'],
    ['Montée sur le trunk (VID 20)', () => `<p>Une ${et(20)} est collée, et la réponse monte vers le routeur.</p>`, null],
    ['Routage retour', () => `<p>Le routeur change l'étiquette : ${et(20)} → ${et(10)}.</p>`, null],
    ['Descente sur le trunk (VID 10)', () => `<p>La réponse redescend vers le switch avec une ${et(10)}.</p>`, null],
    ['PC1 reçoit la réponse', () => '<p>Le switch enlève l\'étiquette : PC1 reçoit la réponse. <strong>Le ping a réussi !</strong></p>',
     () => '<p>TTL initial selon l\'OS : 64 (Linux, macOS), 128 (Windows), 255 (Cisco). Un TTL reçu de 63 = un saut de routage.</p>'],

    ['Ping réussi : bilan', () => `<p><strong>À retenir :</strong></p><ol>
      <li><strong>Deux VLAN = deux salles séparées</strong>, même sur un seul switch.</li>
      <li>Sur le <strong>câble partagé (trunk)</strong>, chaque message porte une étiquette avec le numéro de son VLAN.</li>
      <li>Pour passer d'une salle à l'autre, il faut un <strong>routeur</strong>.</li></ol>`,
     () => `<p>En production, on remplace souvent ce montage par un switch de niveau 3 (SVI + ${c('ip routing')}) ou par un pare-feu,
      qui filtre aussi le trafic entre VLAN.</p>`],

    /* --- Échecs --- */
    ['Échec : la requête ARP ne quitte jamais le switch', () => `<p>Le câble vers le routeur <strong>refuse ${salle(v1)}</strong>.
      Le message de PC1 reste bloqué dans le switch : le ping échoue.</p><p><strong>Solution :</strong> autoriser le VLAN ${v1} sur le trunk.</p>`, null],
    ['Échec : aucune sous-interface', () => `<p>Le routeur reçoit le message, mais il n'a <strong>pas de porte</strong> pour ${salle(v1)} : il le jette.</p>
      <p><strong>Solution :</strong> créer la sous-interface du VLAN ${v1} sur le routeur.</p>`, null],
    ['Échec : incohérence VLAN', () => `<p>PC1 est branché <strong>dans la mauvaise salle</strong> : son adresse est celle de la salle 10, mais son port
      est dans ${salle(v1)}. Le routeur ne lui répond pas.</p><p><strong>Solution :</strong> remettre le port de PC1 dans le VLAN 10.</p>`, null],
    ['Échec : le routeur ne connaît pas', () => `<p>Le routeur ne connaît pas ${salle(20)} : il ne sait pas où envoyer le ping.</p>
      <p><strong>Solution :</strong> créer la sous-interface du VLAN 20.</p>`, null],
    ['Échec : le switch rejette', () => `<p>Le routeur renvoie le message avec une ${et(20)}, mais le câble partagé <strong>refuse le VLAN 20</strong>. Bloqué !</p>
      <p><strong>Solution :</strong> autoriser le VLAN 20 sur le trunk.</p>`, null],
    ['Échec : PC2 est dans le mauvais VLAN', () => `<p>PC2 est branché <strong>dans la mauvaise salle</strong> : le routeur l'appelle dans ${salle(20)},
      mais PC2 est dans ${salle(v2)} et n'entend rien.</p><p><strong>Solution :</strong> mettre le port de PC2 dans le VLAN 20.</p>`, null],
  ];

  for (const st of S) {
    const rule = RULES.find(([prefix]) => st.title.startsWith(prefix));
    if (!rule) continue;
    st.easy = rule[1]();
    if (rule[2]) st.pro = rule[2]();
  }
  /* Titres simplifiés pour le niveau Débutant */
  const EASY_TITLES = {
    'PC1 diffuse une requête ARP': 'PC1 cherche le routeur',
    'Le switch diffuse… dans le VLAN uniquement': 'Le message reste dans sa salle',
    'Réponse ARP taguée sur le trunk': 'Le routeur répond',
    'Le switch retire le tag et livre à PC1': 'Le switch enlève l\'étiquette',
    'PC1 envoie le ping… à la MAC du routeur': 'PC1 confie son ping au routeur',
    'Le routeur route du VLAN 10 vers le VLAN 20': 'Le routeur change d\'étiquette',
    'Le routeur cherche la MAC de PC2': 'Le routeur cherche PC2',
    'Le ping redescend le trunk, tagué 20': 'Le ping redescend avec l\'étiquette 20',
    'Le tag est retiré, PC2 reçoit le ping': 'PC2 reçoit le ping',
  };
  for (const st of S) st.easyTitle = EASY_TITLES[st.title] || st.title;
}

/* ---------- Scénarios prédéfinis ---------- */
const PRESETS = [
  { id: 'arp', label: 'Broadcast ARP', sub: 'Isolation des VLAN', cfg: DEFAULT_CFG, opts: { arp: true, arpOnly: true } },
  { id: 'ping', label: 'Ping inter-VLAN', sub: 'Tags et routage', cfg: DEFAULT_CFG, opts: { arp: false, reply: true } },
  { id: 'full', label: 'Scénario complet', sub: 'ARP + ping aller-retour', cfg: DEFAULT_CFG, opts: { arp: true, reply: true } },
  { id: 'trunk', label: 'Panne : trunk', sub: 'VLAN 20 non autorisé', cfg: { p1: 10, p2: 20, allowed: [10], subs: [10, 20] }, opts: { arp: true, reply: true } },
  { id: 'port', label: 'Panne : mauvais VLAN', sub: 'PC2 sur le VLAN 10', cfg: { p1: 10, p2: 10, allowed: [10, 20], subs: [10, 20] }, opts: { arp: true, reply: true } },
];
