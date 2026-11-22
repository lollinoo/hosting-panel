# ADR 0036 — Formato esteso delle applicazioni (`HCP-STACK/v2`), importatore Compose e WordPress dal catalogo

- **Stato:** `PROPOSTO` — scritto dall'agente su indicazione del proprietario del 2026-11-22 («partirei con WordPress ma vorrei funzionasse come funziona Coolify»); le scelte segnate «scelta dell'agente» non sono state confermate una per una e diventano definitive con il merge della PR #43
- **Data:** 2026-11-22
- **Riferimento:** `ADR-0035` (stack applicativi, che questo ADR modifica nei punti elencati al §2.1), `ADR-0015` (segreti), `ADR-0014` (Traefik a file); issue #42, PR in bozza #43; progetto in `docs/superpowers/specs/2026-11-22-extended-application-format-design.md`
- **Migrazioni:** nessuna (`app_template_versions.spec_version` accetta già valori ≥ 1; il piano è JSONB)

Questo ADR aggiunge un secondo formato di modello, `HCP-STACK/v2`, accanto a `HCP-STACK/v1`, che resta identico. Il v2 serve a far girare immagini ufficiali reali (per prima WordPress con MariaDB) senza dare a nessuno Compose libero né il socket Docker: immagini da qualunque registro ma sempre fissate per digest, un **profilo di esecuzione** chiuso al posto delle capability, segreti consegnati anche come variabili d'ambiente, valori generati dalla piattaforma, e un **importatore** che traduce un file Compose in una bozza v2 che l'amministratore rilegge prima di pubblicarla.

## 1. Contesto

`ADR-0035` ha costruito il catalogo con un formato volutamente stretto: tre immagini in un'allowlist, filesystem in sola lettura, nessuna capability, segreti solo come file. Con quelle regole le immagini ufficiali `wordpress` e `mariadb` non partono (scrivono nel proprio filesystem, cambiano proprietario ai file, scendono di utente da root, leggono le password dall'ambiente). Il proprietario vuole l'esperienza di un PaaS self-hosted, partendo da WordPress.

Nei PaaS di riferimento chi può modificare un'applicazione controlla di fatto il server: il file Compose è eseguito com'è. Qui si porta **che cosa fanno** quelle funzioni, non **come**: l'altro progetto ragiona per team, questo pannello per **cliente**. Tutto ciò che può toccare l'host (modelli, Compose, immagini, proxy) resta dell'amministratore del server; il cliente sceglie dal catalogo e compila un modulo breve.

Restano validi tutti i vincoli di `ADR-0035` §1: solo `hp-docker-executor` parla con Docker; nessuna dipendenza npm, programma dell'host o variabile d'ambiente nuova; clean-room (nessun file di modello copiato da altri progetti: i nomi `SERVICE_*` letti dall'importatore sono una convenzione d'interfaccia, il modello WordPress e i file di prova sono scritti da zero); il prodotto «sito WordPress gestito» non cambia.

## 2. Decisioni

### 2.1 Che cosa cambia di ADR-0035

| Punto di ADR-0035 | Prima | Ora |
|---|---|---|
| §2.3 formato | solo `schemaVersion: 1` | `1` (invariato) oppure `2` (§2.2) |
| §2.5, L5 immagini | digest + riga esatta di `APP_IMAGE_ALLOWLIST` | v1 invariato; v2: digest obbligatorio, repository libero (§2.3) |
| §2.4, L16–L18 corpo del container | un solo corpo indurito | v1 invariato; v2: profilo `strict` (lo stesso corpo) o `standard` (§2.4) |
| §2.6, L6 segreti | solo come file | v1 invariato; v2: anche come variabile d'ambiente, e valori generati (§2.5, §2.6) |
| §2.12 catalogo iniziale | due modelli | più `atpl_wordpress_mariadb` (§2.9) |
| §2.13, L19 flag | tutti `false` | `applicationTemplatesAvailable` e `applicationStacksAvailable` `true` su `linux-systemd` (§2.10) |
| §8.2 seguiti | risoluzione del tag in digest | consegnata (§2.7) |

Tutto il resto di `ADR-0035` (reti, ingresso e TLS, quote, operazioni, volumi, permessi, downgrade `app-stacks`) vale anche per il v2.

### 2.2 Due formati affiancati, non uno allargato

`AppTemplateSpecSchema` e `ApprovedStackPlanSchema` diventano unioni discriminate su `schemaVersion`: l'oggetto v1 non riceve nessuna chiave nuova, quindi una sorgente v1 produce la stessa specifica, lo stesso hash e lo stesso piano di prima, e un piano v1 già salvato resta valido. Una chiave del v2 in una sorgente v1 è `KEY_UNKNOWN`. Il validatore, il compilatore e l'esecutore decidono per versione in pochi punti nominati; non esiste una modalità «non sicura» né un'opzione che allenti il v1.

### 2.3 Immagini (v2)

Il digest resta obbligatorio e `latest` resta rifiutato: il piano porta solo `nome@sha256:…` e l'esecutore scarica per digest e ricontrolla `RepoDigests`. Cade soltanto il vincolo dell'allowlist: l'amministratore può pubblicare un modello con un'immagine di qualunque registro pubblico. Se il repository ha una riga in `APP_IMAGE_ALLOWLIST`, l'utente forzato di quella riga vale ancora. L'allowlist continua a valere per intero sui modelli v1.

Motivo: l'allowlist nel codice rendeva impossibile un catalogo vero; il digest e la gabbia del §2.4 sono le difese che contano. L'immagine la sceglie solo l'amministratore del server.

### 2.4 Profilo di esecuzione (v2)

Ogni servizio v2 dichiara `x-hp-profile: strict | standard` (assente = `strict`). Il nome è l'unica cosa che una sorgente o un piano possono dire: né capability, né utente, né `privileged`, né percorsi dell'host, né porte. Il significato sta in una costante dell'esecutore.

| | `strict` (il corpo di ADR-0035) | `standard` |
|---|---|---|
| Filesystem radice | sola lettura | scrivibile |
| Capability | tolte tutte | tolte tutte, poi aggiunte **solo** `CHOWN`, `DAC_OVERRIDE`, `FOWNER`, `SETGID`, `SETUID`, `NET_BIND_SERVICE` |
| `/tmp` | tmpfs da 64 MiB | quello dell'immagine |
| `PidsLimit` | 256 | 512 |
| Uguale nei due | `Privileged: false`, `no-new-privileges:true`, memoria = swap, quota di CPU, reti dello stack, solo volumi con nome, file dei segreti in sola lettura, nessun `Entrypoint`, nessuna porta dell'host, log json-file 10m × 3 |

L'elenco delle capability è misurato (§7), non copiato: senza `DAC_OVERRIDE` o `FOWNER` WordPress non parte; `KILL` non serve per un arresto pulito. È un sottoinsieme delle capability predefinite di Docker. `assertAppStackPayloadHardening` confronta il corpo con quello chiuso del profilo, chiave per chiave.

### 2.5 Segreti nell'ambiente (v2)

Molte immagini leggono le password solo dall'ambiente. Nel v2 una voce `secret:` il cui nome non finisce in `_FILE` è consegnata come variabile d'ambiente, e `${chiave}` di un parametro segreto è ammesso dentro un `value` dell'ambiente (mai in `command`).

- Il **piano non contiene il valore**: porta `secretEnvironment[{ name, pieces }]`, dove ogni pezzo è un testo letterale oppure `{ parameterKey, version }`, come già fa `secretFiles`. Piano, anteprima, hash, outbox, audit, DTO e log non vedono il testo in chiaro.
- Il valore viaggia solo nella chiamata IPC firmata `create` (campo transitorio `secretContents`, inviato solo se il piano ne ha bisogno) e in quella di avvio; l'esecutore lo scrive in `Config.Env` del container e non lo restituisce mai (non legge `Config.Env` nelle ispezioni che espone).
- Ruotare un segreto = nuova versione → nuovo piano → il componente è ricreato (l'hash del componente copre i pezzi).
- L'esecutore scrive comunque ogni segreto del componente nella sua directory su tmpfs, così il mascheramento dei log copre anche i segreti d'ambiente; nel container sono montati solo quelli di tipo file.
- Una voce senza riferimenti a segreti conserva le regole del v1 (nomi e valori che sembrano segreti sono rifiutati).

Limite accettato: chi può eseguire `docker inspect` sull'host (root) legge l'ambiente di un container; è lo stesso livello di fiducia che già legge i file dei segreti su tmpfs.

### 2.6 Valori generati (v2)

Un parametro `secret` può dichiarare `generate: { kind, length }` con `kind` fra `password`, `hex`, `base64`, `user`. L'API genera il valore con `node:crypto` alla creazione dello stack (e a un upgrade che introduce un parametro generato nuovo) e lo salva come riga normale di `app_stack_secrets`, versione 1. Con `customer: false` (ammesso solo insieme a `generate`) il cliente non lo vede e non può cambiarlo; con `customer: true` può sostituirlo dalla route dei segreti. Il cliente non digita mai una password per installare.

### 2.7 Dal tag al digest

Nuovo metodo dell'esecutore `resolveAppStackImage`: chiede al motore `GET /distribution/<nome[:tag]>/json` e restituisce il digest dell'indice. Lo usa solo l'importatore; non invia credenziali (registri pubblici).

### 2.8 Importatore Compose (solo amministratore)

Funzione pura in `packages/policy-engine`: Compose in ingresso, bozza v2 più un **rapporto** (voci `changed`, `dropped`, `refused`, `info`) in uscita. La route `POST /v1/admin/app-templates/import-compose` risolve i digest, esegue l'importatore e restituisce bozza, rapporto e verdetto del validatore; non salva nulla. L'amministratore rilegge la bozza nell'editor esistente e la salva dalle route esistenti, che la validano di nuovo. Ciò che può toccare l'host (`privileged`, `cap_add`, dispositivi, rete dell'host, percorsi dell'host, `docker.sock`, `build`) è **rifiutato**, non tradotto; le porte pubblicate e le opzioni senza effetto qui sono **tolte** con una riga nel rapporto. Le variabili `SERVICE_PASSWORD_*`, `SERVICE_USER_*`, `SERVICE_BASE64_*`, `SERVICE_HEX_*` diventano parametri generati; `SERVICE_FQDN_*` e `SERVICE_URL_*` diventano un ingresso. Il lettore è il sottoinsieme YAML esistente: un file con ancore o scalari a blocchi è rifiutato con riga e colonna. Le regole complete sono nel progetto, §7.

### 2.9 Modello WordPress

`atpl_wordpress_mariadb` (v2, scritto per questo repository): `wordpress` (immagine ufficiale, profilo `standard`, volume su `/var/www/html`, ingresso sulla porta 80) e `db` (`mariadb` ufficiale, profilo `standard`, volume su `/var/lib/mysql`, solo rete privata), con due segreti generati. È seminato **disattivato** come gli altri modelli iniziali: lo pubblica l'amministratore. Licenze: WordPress GPL-2.0-or-later, MariaDB Server GPL-2.0-only; il pannello non ridistribuisce le immagini, le scarica l'esecutore.

### 2.10 Flag

`applicationTemplatesAvailable` e `applicationStacksAvailable` valgono `true` sul backend `linux-systemd` (scelta dell'agente: la accende un commit separato, così il proprietario può toglierlo dalla PR). `stackPublicPortsAvailable` e `gitBuildsAvailable` restano `false`. Il merge della PR è la decisione del gate W6 di `ADR-0035` §8.1; le prove sulle VM del proprietario elencate lì restano da fare e sono riportate nella PR.

### 2.11 Compatibilità e downgrade

- v1: stessa specifica, stesso hash, stesso piano; i test esistenti non cambiano.
- Una versione di modello salva la versione del proprio formato (`spec_version` 1 o 2).
- Nuovo gate di downgrade `app-format-v2`: `hp-update` rifiuta (codice 8) una release che non conosce il v2 finché esiste uno stack non cancellato installato da una versione v2, o che conserva una revisione scritta nel v2 (una destinazione di rollback che la release precedente non saprebbe leggere). Il gate guarda gli stack, non i modelli: la release 0.9.0 mostra un modello v2 con cifre a zero all'amministratore e lo lascia fuori dal catalogo del cliente, e ogni pannello ha la riga del modello WordPress integrato; un gate sui modelli rifiuterebbe ogni downgrade. Il gate `app-stacks` resta com'è.

## 3. Alternative scartate

- **Eseguire il Compose così com'è**: chi scrive il file controlla il server. Contrario a `ADR-0035` e a `HARNESS.md`.
- **Allargare il v1**: cambierebbe il significato dei modelli già salvati e renderebbe condizionali le garanzie del v1.
- **Capability scelte dal modello** (anche da un elenco ammesso): ogni modello diventerebbe una decisione di sicurezza; un profilo chiuso si verifica una volta.
- **Segreti solo come file anche nel v2**: molte immagini non leggono `*_FILE`; servirebbe uno script d'avvio, cioè una shell.
- **Allowlist dei registri**: non ferma un'immagine ostile su un registro ammesso; il digest e la gabbia sì.

## 4. Limiti noti

1. Lo strato scrivibile di un container `standard` non ha un limite di spazio proprio (i volumi e i log sì).
2. I segreti d'ambiente sono leggibili da root sull'host con `docker inspect` (§2.5).
3. L'importatore non legge ancore, scalari a blocchi e chiavi di fusione; un controllo di salute `exec` diventa una sonda TCP.
4. Nessuna variabile «URL dello stack» dentro un modello: WordPress prende l'indirizzo dalla richiesta.
5. Registri privati non supportati.
6. Un valore sotto un nome che sembra un segreto deve essere un segreto: non c'è un'eccezione per i falsi positivi.

## 5. Minacce (aggiunte a ADR-0035 §6)

| Minaccia | Contromisura |
|---|---|
| T17 — Un modello v2 chiede più privilegi di quelli del profilo | la sorgente e il piano non hanno chiavi per capability, utente, dispositivi o percorsi; il profilo è un nome chiuso; l'esecutore ricostruisce e ricontrolla il corpo |
| T18 — Segreto d'ambiente che esce dal piano, dall'anteprima, dai log o dagli errori | il piano porta solo chiave e versione; i tre cercatori di chiavi vietate girano sull'intero piano; mascheramento dei log sui valori del componente; l'esecutore non restituisce `Config.Env` |
| T19 — Immagine ostile o sostituita | digest obbligatorio, pull per digest, controllo di `RepoDigests`; l'immagine gira nella gabbia del profilo, su reti dello stack, senza porte dell'host |
| T20 — L'importatore traduce in silenzio qualcosa di pericoloso | ciò che tocca l'host è rifiutato; ogni cambiamento è una riga del rapporto; la bozza passa dal validatore stretto prima di essere salvata |
| T21 — Risoluzione dei digest usata per sondare la rete | solo l'amministratore, attraverso il motore Docker, senza credenziali; nome dell'immagine validato |

## 6. Verifica

Test unitari di contratti, validatore, compilatore, importatore ed esecutore (per profilo); test dell'API sul simulatore (installazione con segreti generati, route d'importazione); script su Docker reale `infra/linux/accept-app-stack-wordpress.mjs`; il comando di verifica del repository. Le righe di `HARNESS.md` che cambiano sono la 12 e la 22.

## 7. Fatti misurati

Docker Engine 29.10.0, immagini `wordpress:7.1.4-php8.4-apache@sha256:4bf2c44f19a5eba28de4e5cbe50e1c5dc55ae3f8b894f681f4d7676a7e2512e5` e `mariadb:12.3.3@sha256:4aaf88b3106382c8c18e49f0cec60267be618fc22f858c4503afb2a2555afed3`, corpo `standard` (`--cap-drop ALL` più le sei capability, `no-new-privileges`, 512 pid, memoria = swap = 512 MiB, volumi con nome, database solo su una rete `--internal`):

- entrambi partono; WordPress risponde `200` su `/wp-admin/install.php` senza errori di database; un riavvio con i volumi esistenti funziona;
- `docker stop -t 10` termina in 1,2 s e 0,16 s con uscita 0, senza `KILL`;
- WordPress raggiunge `https://api.wordpress.org` dalla rete edge; il database, solo sulla rete privata, non esce;
- maschera effettiva `00000000000004cb`; `mariadbd` gira come `mysql` con `CapEff 0` e `NoNewPrivs: 1`;
- senza `NET_BIND_SERVICE` funziona tutto (resta nell'elenco per le immagini che ascoltano sotto la 1024 come utente non root); senza `DAC_OVERRIDE` WordPress esce con 1 (`wp-config.php: Permission denied`); senza `FOWNER` esce con 2 (`tar: … Cannot change mode`);
- `GET /distribution/<nome:tag>/json` sul socket del motore risponde 200 con `Descriptor.digest` uguale al digest dell'indice del registro.

## 8. Come costruito

Da completare alla fine del lavoro (commit, esito della verifica, voci aperte, seguiti registrati).
