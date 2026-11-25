/* ==========================================================================
   data.js — Topologie, adressage et génération des configurations
   ========================================================================== */
'use strict';

const NET = {
  pc1: { id: 'pc1', name: 'PC1', ip: '192.168.10.10', prefix: 24, gw: '192.168.10.1', mac: '00:50:79:66:68:01', port: 'Fa0/1' },
  pc2: { id: 'pc2', name: 'PC2', ip: '192.168.20.10', prefix: 24, gw: '192.168.20.1', mac: '00:50:79:66:68:02', port: 'Fa0/2' },
  r:   { id: 'r',   name: 'R1',  mac: '00:1e:7a:3c:10:01', phys: 'G0/0' },
  sw:  { id: 'sw',  name: 'SW1', trunk: 'Gi0/1' },
  bcast: 'ff:ff:ff:ff:ff:ff',
  nativeVlan: 99,
  vlans: {
    10: { name: 'COMPTA', subnet: '192.168.10.0/24', gw: '192.168.10.1' },
    20: { name: 'RH',     subnet: '192.168.20.0/24', gw: '192.168.20.1' },
  },
};

/* Configuration « correcte » de référence */
const DEFAULT_CFG = Object.freeze({ p1: 10, p2: 20, allowed: [10, 20], subs: [10, 20] });

function cloneCfg(cfg) {
  return { p1: cfg.p1, p2: cfg.p2, allowed: [...cfg.allowed], subs: [...cfg.subs] };
}

/* --------------------------------------------------------------------------
   Génération des configurations (Cisco IOS, PC, Linux)
   -------------------------------------------------------------------------- */
function genConfig(cfg) {
  const allowedList = [...cfg.allowed].sort((a, b) => a - b).concat(NET.nativeVlan).join(',');

  const sw = `! ===== SW1 — Cisco IOS (ex. Catalyst 2960) =====
enable
configure terminal
hostname SW1
!
! --- Création des VLAN ---
vlan 10
 name COMPTA
vlan 20
 name RH
vlan 99
 name NATIF
!
! --- Ports d'accès : un seul VLAN, trames NON taguées ---
interface FastEthernet0/1
 description PC1
 switchport mode access
 switchport access vlan ${cfg.p1}
 spanning-tree portfast
!
interface FastEthernet0/2
 description PC2
 switchport mode access
 switchport access vlan ${cfg.p2}
 spanning-tree portfast
!
! --- Port trunk vers le routeur : plusieurs VLAN, trames TAGUÉES 802.1Q ---
interface GigabitEthernet0/1
 description TRUNK vers R1 G0/0
 ! switchport trunk encapsulation dot1q   <- seulement sur les switchs qui gèrent aussi ISL (ex. 3560)
 switchport mode trunk
 switchport trunk native vlan 99
 switchport trunk allowed vlan ${allowedList}
 switchport nonegotiate
!
end
write memory`;

  const subBlocks = [10, 20].map((v) => cfg.subs.includes(v)
    ? `!
interface GigabitEthernet0/0.${v}
 description Passerelle VLAN ${v} - ${NET.vlans[v].name}
 encapsulation dot1Q ${v}
 ip address ${NET.vlans[v].gw} 255.255.255.0`
    : `!
! (sous-interface GigabitEthernet0/0.${v} absente dans cette configuration)`).join('\n');

  const router = `! ===== R1 — Cisco IOS (router-on-a-stick) =====
enable
configure terminal
hostname R1
!
! --- Interface physique : pas d'adresse IP, juste activée ---
interface GigabitEthernet0/0
 description TRUNK vers SW1 Gi0/1
 no ip address
 no shutdown
${subBlocks}
!
! --- VLAN natif : trames non taguées, aucune adresse IP ---
interface GigabitEthernet0/0.99
 description VLAN natif
 encapsulation dot1Q 99 native
!
end
write memory`;

  const pcs = `# ===== PC1 — VLAN 10 =====
# Windows (PowerShell en administrateur)
New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 192.168.10.10 -PrefixLength 24 -DefaultGateway 192.168.10.1
# Linux
sudo ip addr add 192.168.10.10/24 dev eth0
sudo ip route add default via 192.168.10.1

# ===== PC2 — VLAN 20 =====
# Windows (PowerShell en administrateur)
New-NetIPAddress -InterfaceAlias "Ethernet" -IPAddress 192.168.20.10 -PrefixLength 24 -DefaultGateway 192.168.20.1
# Linux
sudo ip addr add 192.168.20.10/24 dev eth0
sudo ip route add default via 192.168.20.1

# Les PC n'ont AUCUNE notion de VLAN : ils envoient des trames Ethernet classiques.`;

  const linux = `# ===== Routeur Linux équivalent (router-on-a-stick) =====
# eth0 est relié au port trunk du switch
sudo modprobe 8021q
sudo ip link add link eth0 name eth0.${10} type vlan id 10
sudo ip link add link eth0 name eth0.${20} type vlan id 20
sudo ip addr add 192.168.10.1/24 dev eth0.10
sudo ip addr add 192.168.20.1/24 dev eth0.20
sudo ip link set eth0 up
sudo ip link set eth0.10 up
sudo ip link set eth0.20 up
# Activer le routage IPv4
sudo sysctl -w net.ipv4.ip_forward=1

# Vérification
ip -d link show eth0.10      # affiche "vlan protocol 802.1Q id 10"
ip route                     # 192.168.10.0/24 dev eth0.10 / 192.168.20.0/24 dev eth0.20

# Capture des trames taguées sur le trunk
sudo tcpdump -i eth0 -e -n vlan`;

  const verify = `SW1# show vlan brief
VLAN Name                             Status    Ports
---- -------------------------------- --------- -------------------------------
1    default                          active    Fa0/3, Fa0/4, ...
10   COMPTA                           active    ${cfg.p1 === 10 ? 'Fa0/1' : ''}${cfg.p1 === 10 && cfg.p2 === 10 ? ', ' : ''}${cfg.p2 === 10 ? 'Fa0/2' : ''}
20   RH                               active    ${cfg.p1 === 20 ? 'Fa0/1' : ''}${cfg.p1 === 20 && cfg.p2 === 20 ? ', ' : ''}${cfg.p2 === 20 ? 'Fa0/2' : ''}
99   NATIF                            active
! (le port trunk Gi0/1 n'apparaît pas ici : c'est normal)

SW1# show interfaces trunk
Port        Mode         Encapsulation  Status        Native vlan
Gi0/1       on           802.1q         trunking      99

Port        Vlans allowed on trunk
Gi0/1       ${allowedList}

SW1# show mac address-table dynamic
          Mac Address Table
-------------------------------------------
Vlan    Mac Address       Type        Ports
----    -----------       --------    -----
  10    0050.7966.6801    DYNAMIC     Fa0/1
  10    001e.7a3c.1001    DYNAMIC     Gi0/1
  20    0050.7966.6802    DYNAMIC     Fa0/2
  20    001e.7a3c.1001    DYNAMIC     Gi0/1
! La MAC du routeur apparaît dans les DEUX VLAN, sur le même port trunk.

R1# show ip route connected
C        192.168.10.0/24 is directly connected, GigabitEthernet0/0.10
L        192.168.10.1/32 is directly connected, GigabitEthernet0/0.10
C        192.168.20.0/24 is directly connected, GigabitEthernet0/0.20
L        192.168.20.1/32 is directly connected, GigabitEthernet0/0.20

R1# show vlans
PC1> ping 192.168.20.10`;

  return { switch: sw, router, pcs, linux, verify };
}

/* Petite aide : convertir une MAC xx:xx:xx:xx:xx:xx en notation Cisco xxxx.xxxx.xxxx */
function macCisco(mac) {
  const h = mac.replace(/:/g, '');
  return `${h.slice(0, 4)}.${h.slice(4, 8)}.${h.slice(8, 12)}`;
}
