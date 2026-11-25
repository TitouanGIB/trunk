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
function buildScenario(cfg, opts) {
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

/* ---------- Scénarios prédéfinis ---------- */
const PRESETS = [
  { id: 'arp', label: 'Broadcast ARP', sub: 'Isolation des VLAN', cfg: DEFAULT_CFG, opts: { arp: true, arpOnly: true } },
  { id: 'ping', label: 'Ping inter-VLAN', sub: 'Tags et routage', cfg: DEFAULT_CFG, opts: { arp: false, reply: true } },
  { id: 'full', label: 'Scénario complet', sub: 'ARP + ping aller-retour', cfg: DEFAULT_CFG, opts: { arp: true, reply: true } },
  { id: 'trunk', label: 'Panne : trunk', sub: 'VLAN 20 non autorisé', cfg: { p1: 10, p2: 20, allowed: [10], subs: [10, 20] }, opts: { arp: true, reply: true } },
  { id: 'port', label: 'Panne : mauvais VLAN', sub: 'PC2 sur le VLAN 10', cfg: { p1: 10, p2: 10, allowed: [10, 20], subs: [10, 20] }, opts: { arp: true, reply: true } },
];
