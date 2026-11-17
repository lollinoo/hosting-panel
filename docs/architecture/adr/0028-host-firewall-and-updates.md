# ADR 0028 — Il Server (M5d): Firewall, Aggiornamenti, Pacchetti, Servizi e Giornali dal Pannello

- **Stato:** `APPROVATO — M5d`
- **Data:** 2026-11-17
- **Riferimento:** quadro di M5d (`M5D-FRAME`, decisioni D1–D28), `ADR-0025`, `ADR-0026`, `ADR-0027`; regole `R198`, `R199`, `R200`, `R201`, `R202`, `R203`
- **Migrazioni:** `0017_m5d_firewall.sql` (additiva). Crea due tabelle. `firewall_open_ports` (`name` chiave primaria): le porte sicure che l'amministratore ha aperto. `firewall_blocks` (`id` chiave primaria, `family` con un vincolo `ipv4` o `ipv6`, `cidr` unico, `note`, `created_at`): gli indirizzi e le reti bloccati.

## 1. Contesto

Con M5c l'amministratore del server riavvia i container del pannello e apre un terminale in un sito. Per tutto il resto del server deve ancora entrare con SSH: aprire una porta, bloccare un indirizzo, aggiornare il pannello, installare gli aggiornamenti di sicurezza, riavviare uno dei quattro servizi del pannello, leggere il loro giornale (il log di systemd, chiamato *journal*).

M5d, l'ultima delle quattro parti di M5, aggiunge:

1. la pagina **Firewall**: le regole di base, sei porte sicure da aprire o chiudere, gli indirizzi e le reti bloccati;
2. la pagina **Aggiornamenti**: il pannello, i container del pannello e i siti rimasti indietro rispetto alle immagini fissate nella versione installata, e i pacchetti del sistema operativo;
3. su **Stato**, la scheda **Servizi del server** con i quattro servizi (`hp-api`, `hp-web`, `hp-docker-executor`, `hp-host-agent`) e un Riavvia per ognuno;
4. su **Log**, sette origini nuove: i giornali dei quattro servizi e dei tre lavori del server (aggiornamento del pannello, aggiornamento dell'elenco dei pacchetti, installazione degli aggiornamenti di sicurezza).

Il lavoro che richiede root lo fa systemd, non l'agente host. Questo documento descrive il codice come è stato costruito. Dove il codice fa una cosa diversa dal quadro o dai rapporti degli architetti, lo dice, con la regola che lo accetta.

## 2. Decisioni

### 2.1 Lavoro da root senza una shell

- **L'agente host resta un utente senza privilegi.** Gira come `hp-agent`, con due sole capacità del kernel: `CAP_NET_ADMIN` (per `nft`) e `CAP_DAC_READ_SEARCH`. In più è nel gruppo `systemd-journal`, per leggere i giornali.
- **I programmi dell'agente sono un elenco chiuso**, con il percorso assoluto: `nft` (`/usr/sbin/nft` o `/usr/bin/nft`), `/usr/bin/uname`, `/usr/bin/df`, `/usr/bin/systemctl`, `/usr/bin/journalctl`, `/usr/bin/apt-get`. Partono con `execFile` senza shell, con un ambiente fisso (solo `PATH` e `LC_ALL=C`), dieci secondi al massimo e un output limitato.
- **Una forma chiusa è l'intera lista degli argomenti** (R198 2.1). `systemctl` accetta solo due forme di `show`, `journalctl` solo `--unit=<u>.service --lines=<n> --output=json --output-fields=MESSAGE --no-pager --quiet` con `u` tra le sette unità e `n` da 1 a 500, `apt-get` solo `-s upgrade` (una simulazione che non cambia niente). Un argomento in più, un ordine diverso o un'unità fuori elenco sono rifiutati prima di avviare il programma. `nft` invece è chiuso dai suoi quattro punti di chiamata, non dal controllo delle forme (R200 3).
- **Sette lavori da root, ognuno con la sua unità.** Ogni lavoro è un servizio systemd `oneshot` di root, avviato da un'unità *path*: un'unità che systemd fa partire quando compare un file.
  - `hp-unit-restart@hp-api`, `@hp-web`, `@hp-docker-executor`, `@hp-host-agent`: `systemctl restart` del servizio;
  - `hp-panel-update`: `/usr/local/sbin/hp-update`, lo stesso comando che l'amministratore usa da SSH;
  - `hp-os-refresh`: `apt-get update`;
  - `hp-os-upgrade`: `unattended-upgrade -v`.
- **L'agente chiede un lavoro scrivendo un file vuoto** in `/run/hosting-panel/host-jobs` (cartella `0700` di `hp-agent`). Il file ha il nome dell'unità. L'unità *path* di root lo vede e avvia il servizio, che come primo passo cancella il file. L'agente non avvia mai il servizio da sé, e non può scegliere il comando: è scritto nel file dell'unità.
- **Un file che nessuno guarda viene tolto** (R198 2.4). Se l'unità *path* del lavoro non è attiva, l'agente cancella il file e rifiuta la richiesta. Così un `reset-failed` fatto ore dopo da SSH non avvia una richiesta vecchia. Un file già presente vuol dire che il lavoro è in corso: la richiesta riceve `RESOURCE_LOCKED`.
- **La fine di un lavoro si legge con `systemctl show`**: stato, risultato, ore di avvio e di fine, codice di uscita.
- **Nell'API un lavoro è un'operazione `host.job`**, con il blocco `host:job` (uno alla volta per tutto il server) e un passo `run`. Parte dopo due secondi. La passata la segue ogni due secondi: se il lavoro non parte entro 120 secondi finisce `OPERATION_INTERRUPTED` («The job did not start. Check Health, then try again.»); la si segue al massimo due ore. Un lavoro che l'agente non può avviare o leggere (un'unità mancante o mascherata: `NOT_SUPPORTED`) non resta aperto per sempre: una richiesta rifiutata così finisce subito «non partito», e una lettura che fallisce così lo chiude come non partito passati i 120 secondi; un agente che non risponde lascia invece il lavoro in attesa (R202 2.1). Sulle due chiamate dei lavori l'agente risponde `NOT_SUPPORTED` solo quando le unità mancano o non sono attive (la frase fissa `HOST_JOB_UNITS_MISSING`); un `systemctl show` che fallisce, scade o dà una risposta che l'agente non sa leggere è `HOST_AGENT_UNAVAILABLE` (`503`, con la frase fissa dei programmi), che per l'API è un agente che non risponde. Scritto il file, la richiesta non avvia più nessun programma: risponde «in corso» con quanto ha letto prima, così una lettura fallita dopo che il lavoro è passato a root non lo chiude come non partito (R203 1). Se l'API si ferma mentre lo segue, smette subito di seguirlo senza scrivere niente: il lavoro va avanti e la sua fine la registra il recupero dopo il successivo avvio (limite 24, R201 1.1). Un lavoro «appartiene» alla richiesta se è partito nello stesso secondo dell'operazione o dopo: systemd dà le ore in secondi interi (R198 2.5).
- **Gli esiti.** `succeeded`, `updated` e `already_current` sono successi; `rolled_back`, `rollback_unhealthy`, `failed` e `not_started` no. Un lavoro finito male dà `HOST_JOB_FAILED` (`502`) con «The job ended with an error. Read its log on the Logs page, then try again.». La fine scrive una riga di audit di sistema: `admin.host_service.restart.end` per i quattro riavvii, `admin.update.panel.end`, `admin.os_packages.refresh.end`, `admin.os_packages.upgrade.end`, con `operationId`, `outcome`, `result`, `exitStatus` e, per il pannello, `fromVersion` e `toVersion`.
- **Il lavoro sui siti ferma tre lavori.** Il riavvio dell'esecutore, l'aggiornamento del pannello e quello dei pacchetti sono rifiutati con `409` mentre gira un backup, un ripristino, un aggiornamento WordPress o un'importazione. Il controllo vale solo per una richiesta nuova, nella stessa transazione che crea l'operazione: una richiesta nuova rifiutata non lascia né operazione né riga di audit, e una richiesta ripetuta con la stessa chiave risponde con la sua prima operazione anche se il lavoro sui siti è partito dopo (R201 1.2).

### 2.2 Il firewall

- **Le regole di base** sono il file `infra/linux/nftables-dedicated.conf`, fissato dal suo SHA-256 nell'agente. Aprono sempre 22, 80 e 443, la porta 3000 del pannello web solo dai bridge dei container (da lì arriva il proxy), ICMP e le risposte; tutto il resto in ingresso è scartato, tranne l'SFTP dei siti sulla 2222, che va a un container (limite 2). Il file ha tre insiemi (*set*) vuoti: `opened_tcp_ports`, `blocked_v4`, `blocked_v6`. Il pulsante «Applica le regole di base» usa la route già esistente `/v1/hosts/{hostId}/security`; dopo, la coda rimanda le liste salvate. Il pulsante c'è solo se il server ha la sua riga `hosts`, scritta dal passo di setup dell'installazione: senza, con le regole di base assenti o vecchie la pagina dice che il server non è registrato e di eseguire da SSH `sudo hp-accounts setup`, poi ricaricare (R201 1.8).
- **Lo stato delle regole di base** è `absent`, `outdated`, `current` o `unmanaged` per l'agente; l'API aggiunge `unreadable` (l'agente non risponde) e `disabled` (agente spento in configurazione).
- **Il pannello cambia il firewall solo su un server il cui installer ha caricato il firewall del pannello** (R202 1.1). Il segno è il file `/etc/nftables.d/hosting-panel.nft`: `install.sh` lo scrive solo dopo aver controllato che SSH ascolti sulla 22, e con `--skip-firewall` (che lo stesso installer consiglia, uscendo con 7, quando SSH è su un'altra porta) non lo scrive. Senza il file (o se non è un file) l'agente non avvia `nft`: la lettura risponde `unmanaged`, l'applicazione delle regole di base (e la loro verifica) finisce fallita con il motivo fisso «panel firewall not installed on this server», e l'invio delle liste è rifiutato come quando le regole di base non sono attuali; l'API risponde a una modifica `409 FIREWALL_BASE_RULES_NOT_CURRENT`, e la passata all'avvio non carica niente. La pagina dice che il pannello non gestisce il firewall di questo server, che quanto vi è salvato non è attivo e come affidarglielo (controllare che SSH ascolti sulla 22, poi rilanciare l'installazione sul server, via SSH, con `--version` e la versione installata che mostra la pagina Aggiornamenti, gli altri argomenti come all'installazione, senza `--skip-firewall`; il pannello si riavvia e resta assente per circa un minuto, R203 2.3); non offre l'applicazione né le modifiche. Una frase sulla pagina non bastava: le regole di base chiudono in ingresso tutto tranne 22, 80, 443 e le porte aperte nella pagina, quindi applicarle su un server con SSH su un'altra porta lo chiude fuori, e la regola di questa parte è che nessuno può chiudere fuori l'amministratore da SSH attraverso il pannello. Le frasi della pagina e della finestra di conferma dicono quali porte restano aperte e di non applicare se SSH ascolta su un'altra porta.
- **Sei porte sicure, per nome:** `http_alt` 8080, `https_alt` 8443, `node_exporter` 9100, `zabbix_agent` 10050, `checkmk_agent` 6556, `nrpe` 5666. Mai 22, 80, 443, 3000, 4000, un database o una porta di Docker.
- **I blocchi** sono un indirizzo o una rete IPv4 (da `/16` in giù) o IPv6 (da `/32` in giù), al massimo 500 per famiglia, con una nota di 200 caratteri al massimo. Sono rifiutati gli indirizzi non validi, quelli IPv4 dentro IPv6 (anche nella forma `::1.2.3.4`, la rete `::/96`, R202 3) e quelli con bit dopo il prefisso. Una lista va dal più nuovo al più vecchio.
- **I blocchi stanno nella catena `prerouting` a priorità `raw`**, prima che Docker traduca le porte pubblicate. Così un blocco vale anche per le porte dei container. Prima dei due scarti la catena accetta sempre la porta 22 e il *neighbour discovery* di IPv6 (i messaggi con cui IPv6 trova il router), così un blocco non toglie SSH né la rete IPv6 al server (R198 2.3).
- **Il database è la fonte.** Ogni modifica, una alla volta, legge prima il kernel. Se la lettura riesce e le regole di base non sono `current`, risponde `409 FIREWALL_BASE_RULES_NOT_CURRENT` («The base firewall rules are not in place. Apply them first.»; con `unmanaged` «The panel firewall is not installed on this server.», R203 3.1). Poi salva, manda all'agente le liste intere (`replaceFirewallSets`) e risponde. Se l'invio fallisce, il log dell'API ha `firewall_sync_failed` con il solo codice.
- **«In vigore»** (`inForce`) si mostra solo quando il kernel ha le regole di base attuali. Una porta o un blocco salvato ma non nel kernel si mostra «Salvato, non attivo»; con il kernel non leggibile, «Non verificato».
- **All'avvio dell'API** le liste salvate vengono mandate all'agente, e riprovate ogni dieci secondi finché l'agente non risponde.
- **L'indirizzo dell'amministratore.** Il proxy passa al pannello web l'indirizzo del browser in `X-Real-Ip`; il pannello web lo manda all'API in `X-HP-Client-Address`, e l'API rifiuta un blocco che lo contiene. È un aiuto contro gli errori, non un confine (§4).
- **Audit.** `admin.firewall.port_open`, `port_close`, `block`, `unblock`, con tipo `firewall` e nessuna organizzazione. Una porta già come voluta risponde `200` e non scrive righe.

### 2.3 Aggiornamenti senza registry

- **Le immagini fissate sono quelle della versione installata.** Il pannello non interroga nessun registry di immagini: confronta le immagini in uso con quelle scritte nella versione installata.
- **Cerca una nuova versione.** L'API legge l'ultima versione pubblicata, in 10 secondi e 1 MiB al massimo. Risponde `newer`, `up_to_date`, `no_release` (nessuna versione pubblicata) o `failed`. Il risultato resta in memoria: dopo un riavvio dell'API è `never_checked`.
- **Aggiorna il pannello** è il lavoro `panel_update`, cioè `hp-update` lanciato da root (§2.1). `hp-update` resta il comando da SSH e funziona come prima. Dura di solito un minuto e mezzo; il database o il proxy possono riavviarsi una volta; se il nuovo pannello non risponde, torna da solo alla versione di prima, e allora l'esecutore di prima, ripartendo, può ricreare il database e il proxy una seconda volta (R202 3). Le versioni di prima e dopo vengono dalla riga della richiesta e dal file della versione installata (R199 1).
- **Un container del pannello** non sull'immagine fissata si sposta con «Applica»: un'operazione `panel.container.apply` nell'esecutore, blocco `panel:container:<nome>`, scaricamento fino a 900 secondi. Il relay di posta fa eccezione: il suo «Applica» non ha un'operazione (§4). «Applica» sul database condiviso dei siti è rifiutato con `409` (`site_work_running`) mentre gira un backup, un ripristino, un aggiornamento WordPress o un'importazione, nella transazione che crea l'operazione; una richiesta ripetuta con la stessa chiave risponde con la sua prima operazione (R202 3).
- **Un sito** su un'immagine diversa da quella fissata si aggiorna con la stessa operazione di Cambia versione (`service.deploy`, blocco `site:<id>`). Un sito fermo è rifiutato («Start the site first, then update its image.»), come un sito già aggiornato. Audit `admin.update.site_image` con l'immagine di prima e di dopo, scritto nella transazione che crea l'operazione e solo quando l'operazione è nuova: se la riga non si scrive, non resta nessuna operazione (R202 2.2). Una richiesta ripetuta risponde con la sua prima operazione solo se la chiave era stata usata per lo stesso sito; una chiave usata per un altro sito non risponde mai con l'operazione del primo (R202 3).

### 2.4 I pacchetti

- **La lettura** è `apt-get -s upgrade`: una simulazione. I pacchetti si dividono in `security`, `distribution` e `other`.
- **Aggiorna l'elenco dei pacchetti** è il lavoro `os_refresh` (`apt-get update`).
- **Installa gli aggiornamenti di sicurezza** è il lavoro `os_upgrade` (`unattended-upgrade -v`). Installa solo quanto la configurazione di `unattended-upgrades` permette. Gli altri pacchetti e il riavvio del server si fanno da SSH: la pagina lo dice. Se `unattended-upgrade` manca, il pulsante non c'è (`canUpgrade: false`). `install.sh` ora installa il pacchetto.

### 2.5 Servizi e giornali

- **Stato** legge dal vivo i quattro servizi: una chiamata all'agente, al massimo 3 secondi. Se fallisce, `hostServices` è `null` e la pagina risponde lo stesso. È l'unica chiamata dal vivo di Stato; gli avvisi non ne fanno.
- **Riavvia un servizio** chiede un motivo, come in M5c, e diventa il lavoro `restart_<servizio>` (§2.1). Lo schema del motivo è lo stesso di M5c: tolti gli spazi ai lati, da 1 a 500 caratteri; un motivo che contiene il carattere U+0000 è rifiutato con `400 VALIDATION_ERROR`, qui e nei riavvii di M5c (R201 1.3).
- **Log** ha dodici origini: le cinque di prima e sette giornali (`hp-api`, `hp-web`, `hp-docker-executor`, `hp-host-agent`, `hp-panel-update`, `hp-os-refresh`, `hp-os-upgrade`), da 1 a 500 righe. Ogni riga ha l'ora e al massimo 2000 caratteri. La lettura di un giornale non è registrata nell'audit, come quella dei log dei container.

## 3. Alternative scartate

- **Dare all'agente `sudo` o una shell di root.** Ogni bug dell'agente diventerebbe un bug di root. Con le unità *path* l'agente può solo chiedere uno di sette comandi fissi.
- **Avviare i servizi con `systemctl start` dall'agente.** Serve un permesso di systemd (polkit) per un utente senza privilegi; il file vuoto non ne ha bisogno.
- **I blocchi nella catena `input`.** Non fermano le porte che Docker pubblica, perché la traduzione dell'indirizzo avviene prima.
- **Il kernel come fonte delle liste.** Dopo un riavvio del server le liste sarebbero perse; il database le tiene.
- **Interrogare un registry per sapere se c'è un'immagine nuova.** Servirebbe un accesso alla rete e una fiducia in più; la versione installata dice già quali immagini vuole.
- **Aggiornare tutti i pacchetti dal pannello.** Un pacchetto fuori dalla sicurezza può cambiare il comportamento del server; resta una scelta fatta da SSH.

## 4. Limiti accettati

Ogni limite dice su cosa non si può contare e cosa fa l'amministratore. Fonti: R198, R199, R200, R201, R202 e i rapporti degli architetti.

1. **`X-HP-Client-Address` è un consiglio, non un confine** (R198 3.2).
   - *Su cosa non si può contare:* che l'API sappia sempre l'indirizzo dell'amministratore. La porta 3000 del pannello web si raggiunge da ogni bridge non interno, e chi la raggiunge senza passare dal proxy può mandare l'indirizzo che vuole. Senza intestazione, o con un valore che non è un indirizzo, il controllo non avviene (R200 3).
   - *Cosa fa l'amministratore:* prima di bloccare una rete controlla che non contenga il proprio indirizzo. Se si chiude fuori, segue l'uscita da SSH del limite 7.
2. **La porta SFTP 2222 non è tra le porte sicure** (R198 3.2).
   - *Su cosa non si può contare:* di aprirla o chiuderla dal pannello. Le regole di base non la filtrano: va a un container, e le regole di base guardano solo le connessioni per il server stesso (la catena `input`), quindi resta aperta anche dopo «Applica le regole di base» (R203 3.4).
   - *Cosa fa l'amministratore:* la gestisce come prima, fuori dalla pagina Firewall.
3. **Momenti senza liste.**
   - *Su cosa non si può contare:* che porte aperte e blocchi valgano sempre. Dopo un riavvio del server le regole di base si caricano con gli insiemi vuoti, e le liste tornano quando l'API parte. «Applica le regole di base» cancella e ricarica la tabella: per un istante le porte aperte sono chiuse e i blocchi tolti, finché la coda non rimanda le liste (R198 2.9).
   - *Cosa fa l'amministratore:* dopo un riavvio o un'applicazione guarda che la pagina dica «Attivo». Se dice «Salvato, non attivo», usa «Applica di nuovo»; se un blocco lo ha chiuso fuori, prima lo sblocca (R202 3).
4. **Nessuna passata periodica sul firewall.**
   - *Su cosa non si può contare:* che una modifica fatta da SSH con `nft` venga corretta da sola. Il pannello rimanda le liste solo a una sua modifica, all'avvio dell'API e dopo «Applica le regole di base».
   - *Cosa fa l'amministratore:* la pagina mostra «Salvato, non attivo» per quanto manca nel kernel; «Applica di nuovo» lo rimette, dopo aver sbloccato un blocco che lo ha chiuso fuori.
5. **L'aggiornamento del pannello ferma per poco anche i siti.**
   - *Su cosa non si può contare:* che il database condiviso e il proxy restino accesi. Possono riavviarsi una volta durante l'aggiornamento, e una seconda se l'aggiornamento torna alla versione di prima.
   - *Cosa fa l'amministratore:* aggiorna in un momento tranquillo.
6. **Solo gli aggiornamenti di sicurezza dal pannello.**
   - *Su cosa non si può contare:* che «Installa gli aggiornamenti di sicurezza» installi i pacchetti `distribution` e `other`, o che riavvii il server quando serve.
   - *Cosa fa l'amministratore:* da SSH, `sudo apt-get upgrade` per gli altri pacchetti e `sudo reboot` quando un aggiornamento lo chiede.
7. **Un blocco ferma anche le risposte, ma non SSH** (R198 2.2).
   - *Su cosa non si può contare:* che il server e i siti ricevano ancora risposte da un indirizzo bloccato (un servizio che un sito chiama, un mirror dei pacchetti): nella catena `raw` non c'è il tracciamento delle connessioni. E un indirizzo bloccato raggiunge ancora la porta 22.
   - *Cosa fa l'amministratore:* non blocca un indirizzo da cui il server dipende. Se un blocco lo chiude fuori dal pannello, entra da SSH ed esegue `sudo nft flush set inet hp_dedicated_filter blocked_v4` (e `blocked_v6` per IPv6). Questo vale fino alla prossima modifica del firewall o al prossimo avvio dell'API, che rimandano le liste salvate: subito dopo toglie il blocco dalla pagina, dove si mostra «Salvato, non attivo».
8. **Un'unità *path* in errore resta in errore** (R198 2.4).
   - *Su cosa non si può contare:* che un lavoro riparta da solo se la sua unità *path* è in stato `failed`: il pannello rifiuta la richiesta.
   - *Cosa fa l'amministratore:* da SSH, `sudo systemctl reset-failed <unità>.path` e `sudo systemctl start <unità>.path`, poi riprova dal pannello.
9. **Un `hp-update` già in corso sembra un errore.**
   - *Su cosa non si può contare:* di distinguere un aggiornamento rifiutato perché un altro è in corso da uno fallito: il blocco di `hp-update` esce con 1, come un passo fallito.
   - *Cosa fa l'amministratore:* legge il giornale «hp-panel-update» nella pagina Log.
10. **Il riavvio dell'agente può tagliare la sua risposta.**
    - *Su cosa non si può contare:* che la richiesta di riavviare `hp-host-agent` riceva sempre una risposta pulita.
    - *Cosa fa l'amministratore:* segue l'operazione su Stato; la sua fine dice com'è andata.
11. **La lettura dei pacchetti può fallire durante un aggiornamento dell'elenco.**
    - *Su cosa non si può contare:* che `apt-get -s` risponda mentre `apt-get update` ha il blocco di apt. Un file dell'elenco che `apt-get update` toglie mentre l'agente ne legge la data viene saltato e non fa fallire la lettura (R202 3); un altro errore nel leggere quella data la fa ancora fallire.
    - *Cosa fa l'amministratore:* ricarica la pagina quando il lavoro è finito.
12. **`nft` 1.0.9 di Ubuntu non è stato provato** (R200 3).
    - *Su cosa non si può contare:* che la sua risposta sia letta come quella di `nft` 1.1.6, su cui sono costruiti i dati dei test. Le regole di base contano come assenti solo con il testo «No such file or directory».
    - *Cosa fa l'amministratore:* dopo l'installazione guarda che la pagina Firewall dica «Attivo»; se no, da SSH `sudo nft list table inet hp_dedicated_filter`.
13. **Il controllo della versione è in memoria.**
    - *Su cosa non si può contare:* che resti dopo un riavvio dell'API (torna `never_checked`), né che un limite di richieste del sito delle versioni si distingua da un errore: entrambi danno `failed`.
    - *Cosa fa l'amministratore:* preme di nuovo «Cerca una nuova versione», più tardi.
14. **In sviluppo un aggiornamento riuscito si legge `already_current`** (R199 1).
    - *Su cosa non si può contare:* senza il file della versione installata le due versioni sono `null`, e un'uscita 0 sembra «già aggiornato». Sul server installato il file c'è.
    - *Cosa fa l'amministratore:* niente sul server; in sviluppo lo sa.
15. **«Applica» sul relay di posta non ha un'operazione** (R200 3).
    - *Su cosa non si può contare:* di seguirlo come gli altri container, né che una richiesta ripetuta con la stessa chiave scriva una riga sola: ne scrive una seconda.
    - *Cosa fa l'amministratore:* guarda la riga del relay su Aggiornamenti o su Stato. Nel registro attività un «Applica» ripetuto del relay compare con due righe `admin.update.component`; il secondo «Applica» non cambia niente (R202 4).
16. **I lavori del server e «Applica» hanno una sola corsia** (R202 4).
    - *Su cosa non si può contare:* che un «Applica» su un container del pannello e un lavoro del server (un riavvio, l'aggiornamento del pannello, un lavoro sui pacchetti) partano mentre l'altro gira: la corsia ne fa uno alla volta. Un «Applica» che aspetta più di 60 secondi finisce fallito (`OPERATION_INTERRUPTED`); un lavoro del server che aspetta più di 120 secondi dietro un «Applica» lungo finisce «non è partito» (`not_started`). Niente parte due volte.
    - *Cosa fa l'amministratore:* vede l'«Applica» fallito o il lavoro non partito sulla pagina Aggiornamenti o su Stato; aspetta che l'altro finisca e riprova.
17. **La sessione durante un aggiornamento del pannello non è verificata** (R198 5).
    - *Su cosa non si può contare:* di restare collegato quando il pannello si riavvia.
    - *Cosa fa l'amministratore:* se la pagina chiede di accedere, accede di nuovo; la fine dell'aggiornamento è comunque nel registro attività.
18. **`unattended-upgrades` può accendere aggiornamenti notturni** (R198 3.1).
    - *Su cosa non si può contare:* che il server non si aggiorni da solo di notte. Su Debian la configurazione del pacchetto può farlo; nessuno lo ha verificato.
    - *Cosa fa l'amministratore:* se non lo vuole, lo spegne da SSH con `sudo dpkg-reconfigure unattended-upgrades`.
19. **Il gruppo dei giornali legge tutto il giornale.**
    - *Su cosa non si può contare:* che l'agente possa leggere solo le sette unità: il gruppo `systemd-journal` legge ogni riga del sistema. Il controllo delle forme lascia leggere solo le sette.
    - *Cosa fa l'amministratore:* niente; sa che l'agente ha quel gruppo.
20. **Quattro comportamenti del pannello web** (R200 3).
    - *Su cosa non si può contare:* che la finestra che segue un lavoro si ricarichi alla sua scadenza; che l'aggiornamento del pannello smetta di dire «in corso» prima di ricaricare la pagina; che un `422` della route dei giornali mostri una frase propria (mostra quella già esistente del visore); di avviare i due lavori dei pacchetti insieme (l'altro pulsante è spento).
    - *Cosa fa l'amministratore:* ricarica la pagina.
21. **Il controllo del proprio indirizzo può mancare** (R200 3).
    - *Su cosa non si può contare:* il controllo quando `X-HP-Client-Address` manca o non è un indirizzo, per esempio chiamando l'API senza il pannello web.
    - *Cosa fa l'amministratore:* come nel limite 1.
22. **Una modifica va avanti se il kernel non si legge.**
    - *Su cosa non si può contare:* il `409` sulle regole di base quando la lettura del kernel fallisce: la modifica viene salvata e mandata lo stesso.
    - *Cosa fa l'amministratore:* guarda lo stato della pagina dopo la modifica; «Non verificato» vuol dire che l'agente non ha risposto.
23. **Le unità di root non hanno righe di isolamento** (R200 3).
    - *Su cosa non si può contare:* un sandbox di systemd attorno ai sette servizi di root; i loro comandi sono fissi e non leggono input dell'agente. Gli script non sono passati da `shellcheck`.
    - *Cosa fa l'amministratore:* niente; i file sono in `/etc/systemd/system/`.
24. **Un lavoro del server va avanti se l'API si ferma** (R201 1.1).
    - *Su cosa non si può contare:* che la fine di un lavoro sia scritta mentre l'API è ferma. Quando l'API si ferma (un riavvio di `hp-api` dal pannello, l'aggiornamento del pannello, uno stop da SSH) smette subito di seguire il lavoro e non scrive niente; il lavoro va avanti sotto systemd. Dopo il successivo avvio, scaduti i 30 secondi di concessione dell'operazione, la passata di recupero legge lo stato del lavoro: se è finito chiude l'operazione e scrive la riga di fine (`admin.update.panel.end`, `admin.host_service.restart.end` e le altre), una volta sola; finché il lavoro gira o l'agente non risponde, l'operazione resta aperta; se la lettura fallisce con `NOT_SUPPORTED`, che l'agente dà solo per un'unità mancante o mascherata, il recupero la chiude come non partita, passati i 120 secondi dall'avvio (R202 2.1); un `systemctl` che fallisce è `HOST_AGENT_UNAVAILABLE` e lascia l'operazione aperta (R203 1.2). Se l'API si ferma nei due secondi prima della richiesta, il lavoro non parte e il recupero lo chiude come non partito (`not_started`). Nel frattempo la pagina Aggiornamenti dice che l'aggiornamento (o il lavoro sui pacchetti) è in corso, segue l'operazione per al massimo 30 minuti e, quando si chiude, mostra il nuovo stato; come «Ultimo aggiornamento» mostra quello precedente, se c'è; il registro attività ha la riga della richiesta e non quella di fine; il blocco `host:job` resta preso, e un altro lavoro del server è rifiutato con `409`.
    - *Cosa fa l'amministratore:* aspetta che l'API riparta e ricarica la pagina. Se l'API resta ferma, nessuna fine viene scritta: la riavvia da SSH con `sudo systemctl start hp-api`.
25. **La porta di SSH la controlla solo l'installer, una volta** (R202 1.5).
    - *Su cosa non si può contare:* che il pannello sappia su quale porta ascolta SSH: l'agente non può leggerla senza un programma fuori dal suo elenco. Se, su un server con il file `/etc/nftables.d/hosting-panel.nft`, l'amministratore sposta poi SSH dalla 22 e la tabella del pannello sparisce (svuotata a mano), la pagina mostra le regole di base assenti e offre di applicarle: la finestra dice quali porte restano aperte, ma non lo ferma. La pagina **Server** del passo 2 (`host-detail-actions.tsx`) manda la stessa richiesta: quando l'agente la rifiuta perché il pannello non gestisce il firewall, mostra un'operazione fallita senza la frase del motivo. Un'installazione successiva con `--skip-firewall` su un server il cui firewall è del pannello lascia il file `/etc/nftables.d/hosting-panel.nft`: il pannello continua a gestire il firewall. Un file cancellato a mano dà lo stesso stato `unmanaged` dell'opzione, anche se la frase della pagina nomina `--skip-firewall` (R203 5).
    - *Cosa fa l'amministratore:* tiene SSH sulla 22 su un server il cui firewall è del pannello; se lo sposta, non applica le regole di base. Un'operazione fallita su **Server** in un server installato con `--skip-firewall` vuol dire che il pannello non gestisce il suo firewall (§2.2).
26. **Il lavoro sui siti non aspetta un lavoro del server** (R202 4).
    - *Su cosa non si può contare:* che un backup, un ripristino, un'importazione o un aggiornamento WordPress non partano durante un lavoro del server: la regola vale in un solo verso (§2.1). Un backup pianificato che parte durante l'aggiornamento del pannello viene interrotto dal riavvio dell'esecutore e finisce fallito con il recupero che esiste.
    - *Cosa fa l'amministratore:* aggiorna il pannello lontano dall'ora dei backup; se un backup è fallito, lo vede nella pagina **Backup** e lo rilancia.
27. **«Attuali» vuol dire che i tre insiemi esistono** (R202 4).
    - *Su cosa non si può contare:* che il pannello veda una catena cambiata a mano o una tabella di una versione precedente che ha gli stessi tre insiemi: le regole di base si leggono `current` e ogni voce «Attivo», anche se il kernel non scarta più niente. Il segno di versione nella tabella arriverà con il primo cambio del file delle regole (M6).
    - *Cosa fa l'amministratore:* non cambia a mano la tabella `inet hp_dedicated_filter`; se l'ha fatto, usa «Applica le regole di base», che la ricarica intera.
28. **L'installer non è un aggiornamento** (R203 2).
    - *Su cosa non si può contare:* che rilanciare `install.sh` sia sicuro come `hp-update`. L'installer rifiuta una versione più vecchia di quella installata (uscita 2, con le due versioni e le due strade: `--version` con quella installata, oppure `hp-update --allow-downgrade`), ma una versione più nuova la installa senza il health check e il rollback di `hp-update`. Il passaggio del firewall al pannello rilancia l'installer, che riavvia il pannello: resta assente per circa un minuto.
    - *Cosa fa l'amministratore:* aggiorna dalla pagina **Aggiornamenti**; rilancia l'installer solo con la versione installata, quando gli affida il firewall. Un controllo nell'installer contro una versione più nuova arriva con M6.

## 5. Modello di fiducia

- **Tutte le quattordici route nuove** sono sotto `v1/admin/` e dietro `requireServerAdmin`: un cliente riceve `403` e una riga di audit.
- **L'agente non sceglie i comandi di root.** Scrive un file vuoto con un nome dell'elenco chiuso; il comando è nel file dell'unità di root. La cartella dei file è `0700` di `hp-agent`: un altro servizio del pannello non può chiedere un lavoro.
- **Ogni programma dell'agente** parte con il percorso assoluto, senza shell, con argomenti presi solo dagli elenchi chiusi. Un input ostile è rifiutato prima di `nft`.
- **Le porte e gli indirizzi** sono controllati nell'API e di nuovo nell'agente, prima di scrivere il programma per `nft`. Le note restano nel database e non arrivano all'agente.
- **Il contenuto dei giornali** non viene salvato; il testo degli errori dell'agente non arriva al browser.

## 6. Conformità alle regole architetturali

- **`AC-F2-04`:** nessuna shell e nessun binario fuori elenco nell'agente; i tre binari nuovi hanno forme chiuse intere.
- **Socket Docker solo nell'esecutore:** «Applica» su un container del pannello è una chiamata nuova e chiusa dell'IPC firmato (`applyPanelContainerPin`), con lo schema dei container fissati.
- **`CP-01`:** ogni lavoro parte solo da una richiesta esplicita dell'amministratore; il riavvio di un servizio chiede un motivo.
- **Isolamento e audit:** il percorso sulle route di amministrazione prova `403` e la riga di audit anche per le route nuove; ogni modifica al firewall, richiesta di lavoro e fine di lavoro è registrata.
- **Nessuna dipendenza npm nuova**, nessun permesso nuovo. Due codici di errore nuovi, `FIREWALL_BASE_RULES_NOT_CURRENT` (`409`) e `HOST_JOB_FAILED` (`502`); due tipi di operazione nuovi, `host.job` e `panel.container.apply`.
- **Testi:** ogni frase in italiano e inglese. Le pagine nuove sono solo per l'amministratore; il cliente non vede niente di nuovo.

## 7. Verifica

- **Test automatici di questo ciclo:**
  - i contratti del firewall (le porte, i blocchi accettati e rifiutati in entrambe le famiglie) e dei lavori: `packages/contracts/test/admin-firewall.test.ts` e `packages/contracts/test/admin-host.test.ts`; gli elenchi chiusi dell'agente: `packages/host-agent-contracts/test/host-agent-contracts.test.ts`;
  - le forme chiuse intere, i sette lavori, la lettura di `systemctl show`, dei giornali, di `apt-get -s` e di `nft`, il file tolto quando l'unità *path* non è attiva: `apps/host-agent/test/host-m5d.test.ts`; il simulatore: `apps/host-agent/test/host-simulator-m5d.test.ts`; le otto unità e la cartella dei file: `apps/host-agent/test/host-job-units.test.ts`; il pin SHA-256 del nuovo file delle regole: `apps/host-agent/test/host-agent.test.ts`;
  - il servizio del firewall (la coda, il controllo delle regole di base, la lista mandata intera, l'avvio): `apps/api/test/firewall.unit.test.ts`; le route del firewall, l'audit e il proprio indirizzo: `apps/api/test/admin-firewall.integration.test.ts`;
  - i lavori, il secondo intero, i tempi e gli esiti: `apps/api/test/host-jobs.test.ts`; i servizi su Stato e il loro Riavvia: `apps/api/test/admin-host-services.integration.test.ts`; Stato con una sola chiamata dal vivo: `apps/api/test/admin-health.integration.test.ts`; le dodici origini di Log: `apps/api/test/admin-logs.integration.test.ts`;
  - aggiornamenti e pacchetti: `apps/api/test/admin-updates.integration.test.ts`; la versione installata: `apps/api/test/release-version.test.ts`; «Applica» nell'esecutore: `apps/docker-executor/test/panel-container-apply.test.ts`;
  - ogni route dell'amministratore risponde a un cliente `403` con una riga di audit, comprese le quattordici nuove: `apps/api/test/admin-route-guard.integration.test.ts`;
  - `install.sh` che installa `unattended-upgrades`: `infra/linux/install.test.ts`; le unità nel pacchetto della versione: `infra/release/release-manifest.test.ts`;
  - pannello web: la pagina Firewall e le sue route BFF in `apps/web/test/admin-firewall.test.ts`; la pagina Aggiornamenti in `apps/web/test/admin-updates.test.ts`; i servizi su Stato e i giornali su Log in `apps/web/test/admin-health.test.ts` e `apps/web/test/admin-logs-audit.test.ts`;
  - le prove della QA sull'agente (nessuna shell nel codice né nelle unità di root, le forme chiuse attraverso il vero avviatore dei programmi, le quattro chiamate a `nft`, liste ostili, il file del lavoro, output ostile dei programmi, l'IPC firmato sulle sette route nuove, il file delle regole): `apps/host-agent/test/m5d-host-qa.test.ts`;
  - le prove della QA sull'API (solo l'amministratore, porte e blocchi rifiutati prima dell'agente, corpi ostili, niente immagini né percorsi nelle risposte, niente dati del server nelle righe di audit, chiavi ripetute, il secondo intero, i lavori bloccati dal lavoro sui siti, agente ed esecutore spenti o lenti, liste cambiate alle spalle del pannello, una modifica e un invio all'avvio nello stesso momento): `apps/api/test/m5d-api-qa.integration.test.ts`;
  - le prove della QA sul web (schermo e route insieme, nessun dato del browser passato senza controllo, dati ostili mostrati come testo, nessun blocco di se stessi, ogni attesa che finisce con una frase, frasi, accessibilità, lato cliente invariato): `apps/web/test/m5d-web-qa.test.ts`;
  - i giri di riparazione (R201, R202, R203): la fine di un lavoro attraverso un riavvio dell'API in `apps/api/test/host-job-end-across-restart.integration.test.ts`; lo stato `unmanaged` sul filo in `packages/contracts/test/contracts.test.ts`; il riavvio dalla pagina e i suoi testi in `apps/web/test/admin-restart.test.ts`; l'installer che rifiuta una versione più vecchia in `infra/linux/install.test.ts`; gli altri casi stanno nei file sopra (`host-m5d`, `host-simulator-m5d`, `m5d-host-qa`, `firewall.unit`, `admin-health.integration`, `admin-firewall`, `m5d-web-qa`);
  - questo documento, il README, `HARNESS.md` e le quattordici route in `docs/api/openapi.yaml`: `apps/api/test/infra-layout.test.ts`.
- **Cosa provano solo i test dell'API:** le route, l'audit, i lavori e i loro esiti sono provati con l'API sul simulatore dell'agente e dell'esecutore, non su systemd né su un kernel.
- **Collaudo su un kernel vero: `infra/linux/accept-m5-firewall.mjs`** (questo documento dice cosa mostra, non quanti passi ha né se è passato). Carica il file delle regole con un `nft` vero dentro un container usa e getta con la sua rete (Alpine, `nft` 1.1.x), usa il codice costruito dell'agente e prova con connessioni vere da un secondo container:
  - il pin del file, e il file caricato due volte;
  - le porte fisse in IPv4 e IPv6;
  - una porta sicura aperta e poi chiusa;
  - un indirizzo e una rete bloccati in IPv4 e in IPv6, con il *neighbour discovery* e la porta 22 che passano ancora;
  - un blocco tolto;
  - un input ostile rifiutato prima di `nft`;
  - alla fine non resta niente.
  Non mostra (R198 5): le unità di root avviate da un file sotto un systemd vero; `hp-update`, `apt-get update` e `unattended-upgrade` lanciati dalle loro unità; il sandbox dell'agente con il gruppo dei giornali; `systemctl show` e `apt-get -s` sul server vero; `nft` 1.0.9 di Ubuntu noble; l'indirizzo che il proxy passa al pannello web; la sessione durante un aggiornamento del pannello; un blocco contro una porta pubblicata da un container fuori da un container usa e getta.
