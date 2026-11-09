# ADR 0017 — Domini dei Siti, Controllo DNS e TLS Automatico con Let's Encrypt

- **Stato:** `APPROVATO — Step 2b`
- **Data:** 2026-11-09
- **Riferimento:** spec `docs/superpowers/specs/2026-11-08-production-hosting-panel-design.md`, `CP-01`, `ADR-014`, `ADR-0016`
- **Migrazioni:** `0006` (additiva, più un indice univoco parziale)

## 1. Contesto

Lo Step 2b permette di collegare più domini a un sito, di verificare il DNS e di ottenere e rinnovare i certificati Let's Encrypt (HTTP-01) senza che il control plane sia in funzione al momento del rinnovo (`CP-01`).

## 2. Decisioni

1. **L'API decide, l'executor scrive.** L'API calcola lo stato dei domini (DNS, certificato, rotte); l'executor traduce una lista di rotte in file dinamici di Traefik, dopo aver verificato ogni hostname (`normalizeSiteDomain(h) === h`), ogni `redirectTo` (`isSiteOrigin`) e che nessuno coincida con hostname o IPv4 del pannello (`HOST_POLICY_DENIED`). Gli aggiornamenti di sola rotta sostituiscono i redeploy: il container del sito non si riavvia quando cambia un dominio.
2. **Traefik riprova ogni dominio fallito a ogni ricaricamento.** Per questo il resolver ACME compare in una rotta solo con il certificato `active` o `requested`, e viene tolto nello stesso passaggio del reconciler in cui si classifica un errore (al più 60 s dopo). Ritardi di nuovo tentativo: `rate_limited` 24 h; altri errori 15 min, 1 h, 3 h, 6 h, poi 24 h. «Controlla ora» non accorcia mai un `rate_limited` e può anticipare gli altri solo fino a `max(adesso, cert_requested_at + 15 min)`: al massimo 4 tentativi l'ora, sotto il limite di 5 fallimenti l'ora.
3. **Un certificato per hostname (un router per host).** Un nome sbagliato non blocca mai il suo gemello `www`.
4. **Un file di storage per CA:** `acme.json` (produzione), `acme-staging.json`, `acme-custom.json`, in `/var/lib/hosting-panel/ingress/acme/`. Passare da staging a produzione non mescola account né certificati.
5. **`acme.json` è letto in sola lettura e tollera le scritture sul posto.** Un file vuoto, troncato o illeggibile dà `readable: false` e non cambia mai lo stato di un certificato né le rotte; un certificato ancora valido ma sparito dallo store mantiene il suo resolver.
6. **Solo IPv4.** Il proxy pubblica su `0.0.0.0`: qualunque record AAAA blocca l'emissione (`ipv6_conflict`).
7. **Transizione intorno a `wordpress.set-url`.** Il cambio di indirizzo principale apre un piano di transizione; WordPress non torna **mai** da `https` a `http` automaticamente e passa a un nome solo se ha un certificato utilizzabile. `set-url` usa `--precise`: le origini nude salvate come valore serializzato intero e le forme codificate in URL non vengono riscritte.
8. **`CP-01`: rinnovo senza control plane.** Le rotte mantengono `certResolver` per ogni host il cui certificato è nello store; proxy, `acme.json` e configurazione statica non cambiano se il control plane è fermo.
9. **Durate Let's Encrypt.** I certificati passano a 64 e poi 45 giorni; la `certificatesDuration` predefinita di Traefik resta, perché il rinnovo avviene comunque per tempo e la soglia di avviso di 14 giorni lascia margine.
10. **Niente HSTS in questa versione**, così un certificato perso non blocca mai i visitatori.
11. **Il certificato del pannello aspetta il DNS come i siti** (decisione del proprietario, 2026-11-09, rivista dopo il test reale che ha mostrato i nuovi ordini a ogni ricaricamento): l'executor mette `certResolver` sulla rotta del pannello solo se il record A punta al server senza AAAA, oppure se nello store c'è già un certificato valido. Ricontrolla ogni 5 minuti; una ricerca DNS fallita mantiene l'ultima decisione e, prima di qualsiasi decisione, non ordina. Il record A del pannello va comunque creato prima dell'installazione; l'installer avvisa se non risolve. Ricevono default: «Anche www»; massimo 10 indirizzi per sito (alias che reindirizzano a quello principale); l'errore sulla porta 80 genera un avviso per l'amministratore.
12. **Il flag `acmeTlsRuntimeAvailable` è `true` su `linux-systemd`**, anche se un setup di sviluppo senza `HP_ACME_EMAIL` ha `acmeEnabled: false` nell'executor.
13. **Il rilevamento del rinnovo usa il cambio di `notAfter`** (nessuna colonna `cert_serial`); i fallimenti di rinnovo vecchi sono filtrati in memoria.

## 3. Limiti noti

- Traefik rinnova **ogni** certificato dello store, usato o no: i certificati dei domini rimossi continuano a essere rinnovati. La pulizia è rimandata.
- Lo stato di limitazione dei certificati sopravvive a rimozione/riaggiunta di un dominio e alla ricreazione del sito: è ricostruito dalle righe di audit di richiesta/fallimento delle ultime 24 h, quindi richiede che quelle righe non siano cancellate entro 24 h.
- Finché il certificato di un dominio principale è `requested`, `www` reindirizza a `https://principale` servito col certificato predefinito fino all'emissione (breve avviso del browser).
- Un'installazione precedente alla 2b con certificati di staging li conserva in `acme.json` dopo il passaggio a produzione (valido per le installazioni nuove).
- Il limite di Let's Encrypt di 1.152 fallimenti consecutivi (pausa dell'account) resta lontano grazie al backoff.
