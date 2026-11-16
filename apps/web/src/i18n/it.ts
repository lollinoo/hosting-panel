import type { BackupProblem } from "@hosting-panel/contracts";

export const it = {
  common: {
    save: "Salva",
    cancel: "Annulla",
    logout: "Esci",
    dateLocale: "it-IT",
    language: "Lingua",
    italian: "Italiano",
    english: "English",
  },
  login: {
    title: "Accedi",
    email: "Email",
    password: "Password",
    totp: "Codice di verifica",
    submit: "Accedi",
    totpHint: "Inserisci il codice a 6 cifre generato dalla tua app di autenticazione.",
    verify: "Verifica",
    back: "Indietro",
  },
  account: {
    title: "Il mio account",
    changePasswordTitle: "Scegli una nuova password",
    changePasswordHint: "Per continuare devi sostituire la password provvisoria con una tua.",
    currentPassword: "Password attuale",
    newPassword: "Nuova password",
    changePasswordSubmit: "Salva password",
    confirmPassword: "Conferma nuova password",
    passwordRule: "Almeno 12 caratteri.",
    passwordMismatch: "Le due password non coincidono.",
    currentPasswordWrong: "La password attuale non è corretta.",
    passwordTitle: "Password",
    passwordSaved: "Password salvata.",
    totpTitle: "Verifica in due passaggi",
    totpOffHint: "Proteggi il tuo account: oltre alla password ti chiederemo un codice dal tuo telefono.",
    totpOnHint: "La verifica in due passaggi è attiva.",
    totpStart: "Attiva",
    totpStep1: "Apri la tua app di autenticazione sul telefono e aggiungi un nuovo account.",
    totpOpenLink: "Apri nell'app di autenticazione",
    totpManual: "Oppure inserisci questa chiave a mano:",
    totpStep2: "Poi scrivi qui il codice a 6 cifre mostrato dall'app.",
    totpConfirm: "Conferma",
    totpEnabled: "Fatto: la verifica in due passaggi è attiva.",
    totpDisable: "Disattiva",
    totpDisableHint: "Per disattivarla inserisci la tua password e un codice dall'app.",
    totpAdminRequired: "Come amministratore devi tenerla sempre attiva.",
    languageTitle: "Lingua",
    back: "Indietro",
    loadError:
      "Non siamo riusciti a caricare le impostazioni di sicurezza. Ricarica la pagina tra un minuto; se il problema continua contatta il tuo amministratore.",
  },
  shell: {
    productName: "Hosting Panel",
    emptyTitle: "Crea il tuo primo sito",
    emptyBody: "Il tuo amministratore può anche crearlo per te.",
    emptyCta: "Crea un sito",
    newSite: "Nuovo sito",
    loadErrorTitle: "Non siamo riusciti a caricare questa pagina",
    loadErrorBody:
      "Qualcosa è andato storto da parte nostra. Ricarica la pagina tra un minuto; se il problema continua contatta il tuo amministratore.",
    switchSite: "Cambia sito",
    yourSites: "I tuoi siti",
    accountMenu: "Menu account",
    account: "Account",
  },
  site: {
    wpAdmin: "Apri WP Admin",
    create: {
      title: "Nuovo sito",
      intro: "Compila questi dati e prepareremo il tuo sito WordPress in pochi minuti.",
      name: "Nome del sito",
      domain: "Indirizzo web",
      domainHint: "es. hotelbellavista.it — lo collegherai a questo server in un passaggio successivo.",
      siteTitle: "Titolo del sito",
      adminUser: "Nome utente amministratore",
      adminEmail: "Email amministratore",
      adminPassword: "Password amministratore",
      passwordHint: "Almeno 12 caratteri.",
      showPassword: "Mostra password",
      hidePassword: "Nascondi password",
      advanced: "Avanzate",
      phpVersion: "Versione PHP",
      recommended: "consigliata",
      submit: "Crea sito",
      submitting: "Creazione in corso...",
      domainConflict: "Questo indirizzo web è già in uso. Controlla di non aver sbagliato a scrivere o scegli un altro indirizzo.",
      fieldInvalid: "Controlla questo campo e riprova.",
      alsoWww: "Usa anche www.{domain}",
    },
    progress: {
      title: "Stiamo preparando il tuo sito",
      create_database: "Preparazione del database",
      deploy_site: "Avvio del sito",
      install_wordpress: "Installazione di WordPress",
      publish_site: "Pubblicazione del sito",
      finish: "Fatto",
      failed: "Non siamo riusciti a completare la preparazione del sito. Riprova — se non funziona di nuovo, contatta il tuo amministratore.",
      retry: "Riprova",
      retrying: "Nuovo tentativo...",
      pollError: "Abbiamo perso la connessione per un attimo e continuiamo a riprovare; se questo messaggio resta, ricarica la pagina.",
    },
    title: "Siti",
    visit: "Visita il sito",
    opensNewTab: "(si apre in una nuova scheda)",
    tabsLabel: "Sezioni del sito",
    tabs: {
      overview: "Panoramica",
      wordpress: "WordPress",
      domains: "Indirizzi web",
      files: "File",
      database: "Database",
      backups: "Backup",
      logs: "Log",
    },
    status: {
      online: "Online",
      stopped: "Fermo",
      problem: "Problema",
      settingUp: "In preparazione",
      maintenance: "In manutenzione",
    },
    statusHint: {
      online: "Il tuo sito è online e funziona.",
      stopped: "Il tuo sito è fermo e i visitatori non possono vederlo.",
      problem: "Il tuo sito ha un problema. Se continua, contatta il tuo amministratore.",
      settingUp: "Stiamo preparando il tuo sito. Ci vorrà poco.",
      maintenance: "Il tuo sito è in manutenzione e tornerà disponibile a breve.",
    },
    overview: {
      statusTitle: "Stato",
      domainsTitle: "Indirizzi web",
      manageDomains: "Gestisci gli indirizzi web",
      noDomains: "Il tuo sito non ha ancora un indirizzo web.",
      activityTitle: "Attività recenti",
      noActivity: "Ancora nessuna attività.",
      activityLoadError: "Non siamo riusciti a caricare le attività recenti. Ricarica la pagina per riprovare.",
      wordpressTitle: "Aggiornamenti di WordPress",
      wordpressNotChecked: "Non ancora controllato.",
      wordpressRunning: "È in corso un aggiornamento.",
      wordpressUnknown: "Non siamo riusciti a raggiungere wordpress.org, quindi non sappiamo se esistono aggiornamenti.",
      wordpressProblem: "Non siamo riusciti a leggere il sito. Apri WordPress per vedere il motivo.",
      wordpressUpToDate: "Tutto aggiornato (controllo del {date}).",
      wordpressCount: "Aggiornamenti disponibili: {count}",
      wordpressLoadFailed: "Non siamo riusciti a caricare i dettagli di WordPress. Ricarica la pagina per riprovare.",
      wordpressLink: "Apri WordPress",
    },
    domainStatus: {
      pending: "In collegamento",
      active: "Funziona",
      failed: "Non funziona",
    },
    activity: {
      domains: "Indirizzi web aggiornati",
      provision: "Sito creato",
      deploy: "Aggiornamento del sito",
      restart: "Riavvio del sito",
      stop: "Arresto del sito",
      wordpressUpdate: "Aggiornamento di WordPress",
      wordpressImport: "Importazione WordPress",
      done: "{action} completato",
      failed: "{action} non riuscito",
      running: "{action} in corso",
    },
    domains: {
      mail: {
        configured: "Le email del tuo sito, come conferme di prenotazione e moduli di contatto, partono da {from} con il nome del tuo sito. Non devi configurare nulla.",
        notConfigured: "Il tuo sito non può ancora inviare email. Chiedi all'amministratore del server di configurarlo, altrimenti conferme di prenotazione e moduli di contatto non arriveranno.",
      },
      title: "Indirizzi web",
      recordsTitle: "Record da creare presso il fornitore del tuo dominio",
      recordsIntro: "Presso il fornitore del tuo dominio, crea un record A per ogni indirizzo qui sotto.",
      type: "Tipo",
      name: "Nome",
      value: "Valore",
      copyFor: "Copia l'indirizzo per {host}",
      copy: "Copia",
      copied: "Copiato",
      mainAddress: "Indirizzo principale",
      redirectsTo: "Reindirizza a {host}",
      makeMain: "Rendi principale",
      checkNow: "Controlla ora",
      checking: "Controllo...",
      remove: "Rimuovi",
      removing: "Rimozione...",
      removeTitle: "Rimuovere {host}?",
      removeConfirm: "I visitatori che usano {host} non raggiungeranno più il tuo sito.",
      cancel: "Annulla",
      addTitle: "Aggiungi un indirizzo web",
      hostname: "Indirizzo web",
      hostnameHint: "es. shop.hotelbellavista.it",
      alsoWww: "Aggiungi anche www",
      add: "Aggiungi",
      adding: "Aggiunta...",
      pending: "Stiamo aggiornando gli indirizzi del tuo sito. Ci vuole un momento.",
      conflict: "Questo indirizzo web è già usato da un altro sito. Toglilo prima dall'altro sito, oppure chiedi al tuo amministratore.",
      errors: {
        invalidHostname: "Questo non sembra un indirizzo web. Scrivine uno come hotel.it o shop.hotel.it, senza https:// e senza percorso.",
        domain_limit: "Un sito può avere al massimo 10 indirizzi web. Rimuovine uno che non usi, poi aggiungi questo.",
        last_domain: "Un sito ha bisogno di almeno un indirizzo web. Aggiungi prima il nuovo indirizzo, poi rimuovi questo.",
        primary_domain: "Questo è l'indirizzo principale. Scegli prima un altro indirizzo come principale, poi rimuovi questo.",
        needs_https: "Aspetta che l'HTTPS sia attivo su questo indirizzo, poi rendilo l'indirizzo principale.",
      },
      state: {
        settingUp: "In preparazione",
        waitingForDns: "In attesa del DNS",
        securing: "Attivazione HTTPS in corso",
        secure: "HTTPS attivo",
        httpsProblem: "HTTPS non ancora attivo",
        httpsExpired: "HTTPS scaduto",
        testCertificate: "Certificato di prova",
      },
      hint: {
        not_found: "Questo indirizzo non punta ancora a nessun server. Crea un record A per {host} con valore {ip} presso il fornitore del tuo dominio. Le modifiche possono richiedere alcune ore; controlliamo in automatico.",
        points_elsewhere: "{host} punta a {seen}, non a questo server. Presso il fornitore del tuo dominio, cambia il suo record A in {ip}.",
        ipv6_conflict: "{host} ha anche un record IPv6 (AAAA). Eliminalo presso il fornitore del tuo dominio: questo server risponde solo su IPv4.",
        lookup_failed: "Non siamo riusciti a controllare in questo momento. Riproveremo automaticamente.",
        rate_limited: "Let's Encrypt ci ha chiesto di attendere prima di creare un altro certificato per questo indirizzo. Riproveremo automaticamente il {time}; non devi fare nulla.",
        port_80_blocked: "Let's Encrypt non è riuscito a raggiungere il tuo sito da internet. Il tuo amministratore del server è stato avvisato. Riproveremo il {time}.",
        not_pointing: "Let's Encrypt ha raggiunto un altro server per {host}. Controlla che il suo record A sia {ip} e che non ci sia un record AAAA. Riproveremo il {time}.",
        caa_blocked: "Un'impostazione presso il fornitore del tuo dominio (un record CAA) non consente Let's Encrypt. Chiedi di consentire letsencrypt.org, oppure elimina il record CAA.",
        other: "Non è stato possibile creare il certificato. Riproveremo il {time}. Se continua, contatta il tuo amministratore del server.",
      },
      hintNoTime: {
        rate_limited: "Let's Encrypt ci ha chiesto di attendere prima di creare un altro certificato per questo indirizzo. Riproveremo automaticamente; non devi fare nulla.",
        port_80_blocked: "Let's Encrypt non è riuscito a raggiungere il tuo sito da internet. Il tuo amministratore del server è stato avvisato. Riproveremo automaticamente.",
        not_pointing: "Let's Encrypt ha raggiunto un altro server per {host}. Controlla che il suo record A sia {ip} e che non ci sia un record AAAA. Riproveremo automaticamente.",
        other: "Non è stato possibile creare il certificato. Riproveremo automaticamente. Se continua, contatta il tuo amministratore del server.",
      },
      pill: { validUntil: "HTTPS attivo fino al {date}" },
    },
    manage: {
      title: "Gestione",
      start: "Avvia",
      stop: "Ferma",
      restart: "Riavvia",
      working: "In corso...",
      done: "Fatto. Il sito è aggiornato.",
      failed: "Non è andata a buon fine. Riprova; se fallisce ancora, contatta il tuo amministratore.",
      slow: "Ci sta mettendo più del solito. Ricarica la pagina tra un minuto per vedere a che punto è.",
      phpVersion: "Versione PHP",
      phpApply: "Cambia versione",
      phpHint: "Il sito si riavvia per qualche secondo.",
      dangerTitle: "Zona pericolosa",
      dangerHint: "L'eliminazione di un sito non si può annullare.",
      delete: "Elimina il sito",
    },
    delete: {
      title: "Eliminare questo sito?",
      body: "Stai per eliminare definitivamente {name}: tutti i suoi file, il suo database e la configurazione del suo indirizzo web. L'operazione non si può annullare. Anche i backup di questo sito non saranno più disponibili, quindi scarica prima tutto ciò che ti serve.",
      typeName: "Scrivi {name} per confermare",
      cancel: "Annulla",
      confirm: "Elimina il sito",
      deleting: "Eliminazione...",
    },
    logs: {
      visits: "Visite",
      errors: "Errori",
      refresh: "Aggiorna",
      loading: "Caricamento...",
      empty: "Non c'è ancora nulla da mostrare.",
      unavailable: "I log non sono disponibili in questo momento. Riprova tra un minuto.",
    },
    files: {
      rootLabel: "File del sito",
      breadcrumb: "Percorso della cartella",
      loading: "Caricamento dei file...",
      empty: "Questa cartella è vuota. Trascina qui i file oppure scegli Carica.",
      notReady: "Il sito è ancora in preparazione. I suoi file compariranno qui appena sarà pronto.",
      retry: "Riprova",
      cancel: "Annulla",
      truncated:
        "Questa cartella contiene troppi elementi: ne mostriamo solo i primi. Sposta alcuni elementi in sottocartelle per vederli tutti.",
      selected: "{count} selezionati",
      nameRule: "Il nome non può essere vuoto, contenere / o essere composto solo da punti.",
      dropHint: "Rilascia qui i file per caricarli in questa cartella",
      folderUploadHint:
        "Le cartelle non si possono caricare direttamente. Comprimi la cartella in uno zip sul tuo computer, carica lo zip e poi scegli Estrai.",
      list: {
        caption: "File e cartelle in {folder}",
        name: "Nome",
        size: "Dimensione",
        changed: "Ultima modifica",
        selectAll: "Seleziona tutto in questa cartella",
        select: "Seleziona {name}",
        folder: "Cartella",
        protected: "Protetto: gestito dal pannello",
        shortcut: "Collegamento: non si può aprire da qui",
      },
      actions: {
        toolbar: "Azioni sui file",
        upload: "Carica",
        newFolder: "Nuova cartella",
        download: "Scarica",
        edit: "Modifica",
        rename: "Rinomina",
        move: "Sposta",
        compress: "Comprimi in zip",
        extract: "Estrai",
        delete: "Elimina",
        clear: "Annulla selezione",
        protectedHint: "Alcuni elementi selezionati sono protetti e non si possono modificare.",
      },
      upload: {
        title: "Caricamenti",
        summary: "{done} di {total} file caricati",
        bytes: "{sent} di {total}",
        waiting: "In attesa",
        uploading: "Caricamento in corso",
        done: "Caricato",
        failed: "Non caricato",
        cancelled: "Annullato",
        cancelOne: "Annulla il caricamento di {name}",
        retryOne: "Riprova a caricare {name}",
        cancelAll: "Annulla tutti",
        dismiss: "Chiudi",
        largeHint:
          "I file molto grandi possono richiedere molto tempo per il caricamento e questa pagina deve restare aperta fino al termine.",
        leaveWarning: "Ci sono caricamenti in corso. Se lasci questa pagina verranno interrotti.",
        sessionEnded:
          "La sessione è scaduta. Accedi di nuovo in un'altra scheda, poi scegli Riprova: il caricamento riparte da dove si era fermato.",
        replaceTitle: "Sostituire i file esistenti?",
        replaceBody:
          "Questi file esistono già in questa cartella: {names}. Se li sostituisci, le versioni attuali andranno perse.",
        replace: "Sostituisci",
        skip: "Salta questi file",
      },
      newFolder: {
        title: "Nuova cartella",
        label: "Nome della cartella",
        submit: "Crea cartella",
        working: "Creazione in corso...",
      },
      rename: {
        title: "Rinomina {name}",
        label: "Nuovo nome",
        submit: "Rinomina",
        working: "Rinomina in corso...",
        warning: "Se il sito usa questo elemento, le pagine che lo richiamano smetteranno di funzionare.",
      },
      move: {
        titleOne: "Sposta {name}",
        titleMany: "Sposta {count} elementi",
        choose: "Scegli la cartella di destinazione",
        here: "Sposta qui",
        working: "Spostamento in corso...",
        open: "Apri la cartella {name}",
        noFolders: "Qui non ci sono cartelle.",
        intoItself: "Una cartella non può essere spostata dentro sé stessa. Scegli un'altra cartella.",
        sameFolder: "Questi elementi sono già in questa cartella. Scegline un'altra.",
      },
      delete: {
        titleOne: "Eliminare {name}?",
        titleMany: "Eliminare {count} elementi?",
        bodyFile:
          "Il file verrà eliminato definitivamente. Non si può annullare e il sito potrebbe smettere di funzionare se usa questo file.",
        bodyFolder:
          "La cartella e tutto il suo contenuto verranno eliminati definitivamente. Non si può annullare e il sito potrebbe smettere di funzionare se usa questi file.",
        bodyMany:
          "Questi {count} elementi, con tutto il contenuto delle cartelle, verranno eliminati definitivamente. Non si può annullare e il sito potrebbe smettere di funzionare se li usa.",
        confirm: "Elimina definitivamente",
        working: "Eliminazione in corso...",
      },
      compress: {
        title: "Comprimi in zip",
        label: "Nome del file zip",
        hint: "Il file zip viene salvato in questa cartella. I tuoi file restano come sono.",
        defaultName: "archivio",
        submit: "Comprimi",
        working:
          "Compressione in corso... Le cartelle grandi possono richiedere qualche minuto. Puoi continuare a usare questa pagina.",
        done: "{name} è pronto, con {count} elementi.",
      },
      extract: {
        title: "Estrai {name}",
        label: "Estrai nella cartella",
        hint: "Se la cartella non esiste la creiamo. Lascia il campo vuoto per estrarre qui. I file già presenti non vengono mai sostituiti.",
        submit: "Estrai",
        working:
          "Estrazione in corso... Gli zip grandi possono richiedere qualche minuto. Puoi continuare a usare questa pagina.",
        done: "Estratti {count} elementi.",
      },
      editor: {
        title: "Modifica {name}",
        label: "Contenuto di {name}",
        loading: "Apertura del file...",
        warning: "Un errore qui può bloccare il sito. Se non sei sicuro, scarica prima una copia.",
        mixedLineEndings: "Questo file usa fine riga diversi. Salvando verranno resi tutti uguali.",
        save: "Salva",
        saving: "Salvataggio in corso...",
        saved: "Salvato.",
        close: "Chiudi",
        unsaved: "Hai modifiche non salvate.",
        discard: "Chiudi senza salvare",
        keep: "Continua a modificare",
        changed: "Questo file è stato modificato altrove dopo che lo hai aperto.",
        saveAnyway: "Salva comunque",
        reload: "Ricarica il file",
        tooBig:
          "Questo file è troppo grande per modificarlo qui (oltre 512 KB). Scaricalo, modificalo sul tuo computer e caricalo di nuovo.",
        tooBigNow:
          "Il testo ora supera 512 KB e non si può salvare qui. Accorcialo oppure modifica il file sul tuo computer.",
        notText: "Questo file non è testo semplice, quindi non si può modificare qui. Puoi invece scaricarlo.",
      },
      errors: {
        NOT_FOUND:
          "Questo file o cartella non c'è più: forse è stato spostato o eliminato. Aggiorna l'elenco e riprova.",
        ALREADY_EXISTS: "Qui esiste già un elemento con questo nome. Scegli un altro nome.",
        VALIDATION_ERROR:
          "Questo nome o percorso non si può usare. Il nome non può contenere / o essere composto solo da punti. Correggilo e riprova.",
        PERMISSION_DENIED:
          "Questo elemento è protetto e non si può modificare da qui. Se devi cambiarlo, chiedi al tuo amministratore.",
        NOT_SUPPORTED: "Su questo server la gestione dei file non è ancora disponibile. Contatta il tuo fornitore di hosting.",
        DOCKER_ENGINE_UNAVAILABLE: "Al momento i file del sito non sono raggiungibili. Attendi un minuto e riprova.",
        OPERATION_AMBIGUOUS:
          "Abbiamo perso la connessione prima della risposta del server: la modifica potrebbe essere stata fatta oppure no. Aggiorna l'elenco per controllare.",
        OPERATION_INTERRUPTED:
          "L'operazione ha richiesto troppo tempo ed è stata interrotta: potrebbe essere stata completata solo in parte. Aggiorna l'elenco e riprova.",
        UNAUTHENTICATED: "La sessione è scaduta. Accedi di nuovo per continuare.",
        ORGANIZATION_SUSPENDED:
          "Il tuo account è sospeso: puoi vedere i file ma non modificarli. Contatta il tuo fornitore di hosting.",
        uploadRead: "Non è stato possibile leggere questo file dal tuo computer. Scegli di nuovo il file.",
        uploadTooLarge: "Questo file supera il limite di 2 GB. Scegli un file più piccolo o dividilo prima di caricarlo.",
        quotaUpload:
          "Sul server non c'è abbastanza spazio per questo file. Elimina i file che non ti servono più e riprova.",
        quotaZip:
          "È troppo grande per comprimerlo o estrarlo qui, oppure lo spazio non basta. Prova con meno elementi, elimina i file che non ti servono più oppure estrai sul tuo computer e carica i file.",
        zipValidation:
          "Questo file non è un archivio zip valido oppure contiene elementi non consentiti. Prova a crearlo di nuovo.",
        zipExists: "Qui esiste già un file o una cartella con questo nome. Scegli un altro nome.",
        zipInterrupted: "L'operazione ha richiesto troppo tempo ed è stata interrotta. Prova con meno file.",
      },
      sftpLink: "Collegati con un programma SFTP",
      sftp: {
        title: "Accesso SFTP",
        back: "Torna ai file",
        intro:
          "Con un programma SFTP come FileZilla o WinSCP, tu o il tuo sviluppatore potete lavorare sui file di questo sito dal computer. Ogni persona ha il proprio nome utente e la propria password e può accedere solo ai file di questo sito.",
        unavailable:
          "L'accesso SFTP non è ancora disponibile su questo server. Puoi comunque gestire i file nella scheda File.",
        details: "Dati di connessione",
        detailsUnavailable:
          "I dati di connessione non sono ancora disponibili. Contatta il tuo fornitore di hosting.",
        protocol: "Protocollo",
        host: "Indirizzo del server",
        port: "Porta",
        usernameHint: "Nome utente: uno degli utenti qui sotto",
        fingerprintTitle: "Verifica l'identità del server",
        fingerprintBody:
          "Al primo collegamento il programma mostra un'impronta e chiede se fidarti. Prosegui solo se corrisponde a questa:",
        copyFor: "Copia {what}",
        copied: "Copiato",
        users: "Utenti",
        count: "{count} di {max} utenti",
        empty: "Non ci sono ancora utenti SFTP. Aggiungine uno per collegarti con un programma SFTP.",
        name: "Nome utente",
        createdAt: "Creato",
        passwordChanged: "Password cambiata",
        actions: "Azioni",
        add: "Aggiungi utente",
        limit:
          "Questo sito ha già il numero massimo di {max} utenti SFTP. Eliminane uno che non serve più per aggiungerne un altro.",
        create: {
          title: "Aggiungi un utente SFTP",
          label: "Nome",
          hint: "Usa da 1 a 16 lettere minuscole o numeri, senza spazi. Davanti aggiungiamo un codice breve del sito. Vedrai il nome utente completo nell'elenco.",
          submit: "Aggiungi utente",
          working: "Aggiunta in corso...",
        },
        created: {
          title: "Utente aggiunto",
          tempFor: "Password per {name}:",
          copy: "Copia",
          copied: "Copiato",
          copyUnavailable:
            "Qui non è possibile copiare automaticamente. Seleziona la password e copiala a mano.",
          tempNote:
            "Inseriscila nel programma SFTP insieme a nome utente, indirizzo del server e porta.",
          tempOnce: "La mostriamo una sola volta: copiala adesso. Se la perdi, crea una nuova password.",
          done: "Fatto",
        },
        reset: {
          action: "Nuova password",
          title: "Creare una nuova password per {name}?",
          body: "La password attuale smette subito di funzionare. Chi la usa avrà bisogno di quella nuova per collegarsi. Le connessioni aperte per questo utente terminano subito e gli altri utenti SFTP vengono disconnessi per un istante (possono ricollegarsi subito).",
          confirm: "Crea nuova password",
          working: "Creazione in corso...",
          doneTitle: "Nuova password pronta",
        },
        remove: {
          action: "Elimina",
          title: "Eliminare l'utente {name}?",
          body: "{name} non potrà più collegarsi. I file del sito non vengono toccati. Le connessioni aperte per questo utente terminano subito e gli altri utenti SFTP vengono disconnessi per un istante (possono ricollegarsi subito).",
          confirm: "Elimina utente",
          working: "Eliminazione in corso...",
        },
        errors: {
          QUOTA_EXCEEDED:
            "Questo sito ha già il numero massimo di 10 utenti SFTP. Eliminane uno che non serve più, poi riprova.",
          ALREADY_EXISTS: "Questo nome è già usato su questo sito. Scegline un altro.",
          VALIDATION_ERROR:
            "Questo nome non si può usare. Usa da 1 a 16 lettere minuscole o numeri, senza spazi.",
          DOCKER_ENGINE_UNAVAILABLE:
            "Al momento non è stato possibile aggiornare l'accesso SFTP. Attendi un minuto e riprova.",
          ORGANIZATION_SUSPENDED:
            "Il tuo account è sospeso: non è possibile gestire l'accesso SFTP. Contatta il tuo fornitore di hosting.",
        },
      },
    },
    database: {
      title: "Database",
      intro:
        "Il tuo sito conserva i contenuti in un database. Qui puoi aggiungere database e utenti per altri programmi, scegliere quale utente può usare quale database e aprire phpMyAdmin per lavorare sui dati.",
      prefixNote: "Ogni nome inizia con {prefix}_ così appartiene solo a questo sito.",
      loadFailed: "Non è stato possibile caricare i database. Attendi un minuto e ricarica la pagina.",
      unavailable:
        "Su questo server non è possibile gestire i database. Se ne hai bisogno, contatta il tuo fornitore di hosting.",
      primaryBadge: "Usato dal sito",
      primaryNote:
        "Il sito ha bisogno di questo database e del suo utente per funzionare, quindi non puoi eliminarli né modificarli qui.",
      name: "Nome",
      actions: "Azioni",
      databases: {
        heading: "Database",
        size: "Dimensione",
        count: "{count} di {max} database aggiuntivi",
        empty: "Non hai ancora aggiunto database.",
        add: "Aggiungi database",
        limit:
          "Questo sito ha già il massimo di {max} database aggiuntivi. Eliminane uno che non ti serve più per aggiungerne un altro.",
        create: {
          title: "Aggiungi un database",
          label: "Nome",
          hint: "Usa da 1 a 16 lettere minuscole, numeri o trattini bassi, iniziando con una lettera o un numero.",
          preview: "Nome completo: {name}",
          submit: "Aggiungi database",
          working: "Aggiunta in corso...",
        },
        remove: {
          action: "Elimina",
          title: "Eliminare il database {name}?",
          body: "Tutte le tabelle e i dati di {name} vengono eliminati definitivamente e non si possono recuperare. Gli utenti perdono l'accesso e i programmi che lo usano smettono di funzionare.",
          confirm: "Elimina database",
          working: "Eliminazione in corso...",
        },
      },
      users: {
        heading: "Utenti del database",
        access: "Può usare",
        noAccess: "Ancora nessun database",
        count: "{count} di {max} utenti aggiuntivi",
        empty: "Non hai ancora aggiunto utenti del database.",
        add: "Aggiungi utente",
        limit:
          "Questo sito ha già il massimo di {max} utenti del database aggiuntivi. Eliminane uno che non ti serve più per aggiungerne un altro.",
        create: {
          title: "Aggiungi un utente del database",
          label: "Nome",
          hint: "Usa da 1 a 16 lettere minuscole, numeri o trattini bassi, iniziando con una lettera o un numero.",
          preview: "Nome utente completo: {name}",
          submit: "Aggiungi utente",
          working: "Aggiunta in corso...",
        },
        created: {
          title: "Utente aggiunto",
          tempFor: "Password per {name}:",
          copy: "Copia",
          copied: "Copiata",
          copyUnavailable:
            "Qui non è possibile copiare. Seleziona la password e copiala a mano.",
          tempNote:
            "Usala nel codice del sito insieme al nome utente. Il server del database è lo stesso che usa WordPress (DB_HOST in wp-config.php).",
          tempOnce: "La mostriamo una sola volta: copiala ora. Se la perdi, crea una nuova password.",
          done: "Fatto",
        },
        reset: {
          action: "Nuova password",
          title: "Creare una nuova password per {name}?",
          body: "La password attuale smette subito di funzionare e le connessioni aperte di questo utente si chiudono immediatamente. Aggiorna tutti i programmi che la usano.",
          confirm: "Crea nuova password",
          working: "Creazione in corso...",
          doneTitle: "Nuova password pronta",
        },
        remove: {
          action: "Elimina",
          title: "Eliminare l'utente {name}?",
          body: "{name} non potrà più usare nessun database e le connessioni aperte di questo utente si chiudono immediatamente. I database e i loro dati non vengono toccati.",
          confirm: "Elimina utente",
          working: "Eliminazione in corso...",
        },
        grants: {
          action: "Scegli i database",
          title: "Database che {name} può usare",
          hint: "{name} ottiene accesso completo a ogni database che selezioni e lo perde su quelli che deselezioni. Rimuovere l'accesso chiude subito le eventuali connessioni aperte di questo utente.",
          noDatabases: "Aggiungi prima un database.",
          save: "Salva",
          working: "Salvataggio in corso...",
          partial:
            "Alcune modifiche non sono state salvate. L'elenco ora mostra la situazione attuale.",
        },
      },
      phpmyadmin: {
        heading: "phpMyAdmin",
        body: "Apri phpMyAdmin per consultare le tabelle, eseguire query e importare o esportare dati. L'accesso è automatico e vedi solo i database di questo sito.",
        warning:
          "Le modifiche fatte in phpMyAdmin hanno effetto subito. Se elimini lì il database del sito, il sito smette di funzionare.",
        importNote:
          "phpMyAdmin accetta file fino a 32 MB e il caricamento deve finire entro un minuto. Per un database più grande, comprimi il file (.gz o .zip) o dividilo in parti più piccole.",
        open: "Apri phpMyAdmin",
        opening: "Apertura in corso...",
        unavailable:
          "phpMyAdmin non è disponibile su questo server. Se ne hai bisogno, contatta il tuo fornitore di hosting.",
        popupBlocked:
          "Il browser ha bloccato la nuova scheda. Consenti i pop-up per questo pannello e riprova.",
        downTitle: "phpMyAdmin non è disponibile in questo momento",
        downBody:
          "Attendi un minuto e riprova. Se il problema continua, contatta il tuo fornitore di hosting.",
        backToDatabases: "Torna ai database del sito",
      },
      errors: {
        QUOTA_EXCEEDED:
          "Questo sito ha già il massimo di 10 database o utenti aggiuntivi. Eliminane uno che non ti serve più e riprova.",
        ALREADY_EXISTS: "Questo nome è già usato su questo sito. Scegline un altro.",
        VALIDATION_ERROR:
          "Questo nome non si può usare. Usa da 1 a 16 lettere minuscole, numeri o trattini bassi, iniziando con una lettera o un numero.",
        NOT_FOUND:
          "Questo database o utente non esiste più. L'elenco è stato aggiornato. Se ne hai bisogno, contatta il tuo fornitore di hosting.",
        RESOURCE_LOCKED: "Un'altra modifica è ancora in corso. Attendi un minuto e riprova.",
        DOCKER_ENGINE_UNAVAILABLE:
          "Non è stato possibile aggiornare i database. Attendi un minuto e riprova.",
        OPERATION_AMBIGUOUS:
          "Non abbiamo potuto confermare la modifica. L'elenco è stato aggiornato: controllalo prima di riprovare.",
        NOT_SUPPORTED:
          "Non disponibile su questo server. Se ne hai bisogno, contatta il tuo fornitore di hosting.",
        ORGANIZATION_SUSPENDED:
          "Il tuo account è sospeso: non è possibile gestire i database. Contatta il tuo fornitore di hosting.",
      },
    },
    backups: {
      title: "Backup",
      subtitle:
        "Ogni notte salviamo una copia dei file e dei database del tuo sito in uno spazio esterno a questo server. Ogni copia resta disponibile per {days} giorni.",
      empty:
        "Non ci sono ancora backup di questo sito. Il primo verrà fatto stanotte, oppure puoi farne uno adesso.",
      notAvailable:
        "Su questo server i backup non sono disponibili. Se ti servono, contatta il tuo fornitore di hosting.",
      notSetUp:
        "I backup non sono ancora attivi su questo server: l'amministratore deve prima indicare dove salvarli. Contatta il tuo fornitore di hosting.",
      loadFailed:
        "Non riusciamo a caricare i backup in questo momento. Attendi un minuto e ricarica la pagina.",
      backupNow: "Fai un backup adesso",
      backupNowHint:
        "Teniamo gli ultimi {kept} backup fatti a mano: quando uno nuovo riesce, il più vecchio fatto a mano viene eliminato.",
      running: "Backup in corso\u2026 Il sito resta online e puoi lasciare questa pagina.",
      columns: {
        date: "Data",
        kind: "Tipo",
        size: "Dimensione",
        status: "Stato",
        expires: "Disponibile fino al",
        actions: "Azioni",
      },
      kind: { nightly: "Notturno", manual: "Fatto a mano", pre_update: "Prima di un aggiornamento o di un'importazione" },
      status: { running: "In corso", succeeded: "Completato", failed: "Non riuscito" },
      keptLatest: "Finché non ne riesce uno più recente",
      problem: {
        unreachable:
          "Lo spazio dove salviamo i backup non è raggiungibile. Riprova più tardi; se continua, contatta il tuo fornitore di hosting.",
        tls_failed:
          "La connessione sicura con lo spazio dei backup non è riuscita. Contatta il tuo fornitore di hosting.",
        wrong_region:
          "Lo spazio dei backup non è impostato correttamente. Contatta il tuo fornitore di hosting.",
        auth_failed:
          "Lo spazio dei backup ha rifiutato l'accesso. Contatta il tuo fornitore di hosting.",
        bucket_missing:
          "Lo spazio dei backup non esiste più. Contatta il tuo fornitore di hosting.",
        write_denied:
          "Non abbiamo il permesso di scrivere nello spazio dei backup. Contatta il tuo fornitore di hosting.",
        wrong_key:
          "Lo spazio dei backup contiene copie protette da un'altra chiave. Contatta il tuo fornitore di hosting.",
        key_file_missing:
          "Sul server la chiave che protegge i backup manca o non è valida. Contatta il tuo fornitore di hosting.",
        tool_unavailable:
          "Il server non è riuscito ad avviare il backup. Riprova tra qualche minuto; se continua, contatta il tuo fornitore di hosting.",
        no_space:
          "Sul server non c'è abbastanza spazio libero per preparare il backup. Contatta il tuo fornitore di hosting.",
        database_dump_failed:
          "Non siamo riusciti a copiare i database del sito. Riprova tra qualche minuto; se succede di nuovo, contatta il tuo fornitore di hosting.",
        files_unreadable:
          "Alcuni file del sito non si possono leggere, quindi il backup non è completo. Controlla i permessi nella scheda File oppure contatta il tuo fornitore di hosting.",
        repository_locked:
          "Era già in corso un altro backup di questo sito. Riprova tra qualche minuto.",
        timeout:
          "Il backup ha impiegato troppo tempo ed è stato fermato. Riprova più tardi; se succede di nuovo, contatta il tuo fornitore di hosting.",
        interrupted:
          "Il backup si è interrotto perché il server si è riavviato. Fanne uno nuovo con «Fai un backup adesso».",
        other:
          "Il backup non è riuscito. Riprova; se succede di nuovo, contatta il tuo fornitore di hosting.",
        site_busy: "Il sito stava completando un'altra modifica. Riprova tra qualche minuto.",
        restore_prepare_failed:
          "Non è stato possibile preparare il backup per il ripristino, quindi non è cambiato nulla. Riprova; se succede di nuovo, contatta il tuo fornitore di hosting.",
        switch_undone:
          "L'ultimo passaggio del ripristino non è stato completato, quindi tutto è stato rimesso com'era. Può succedere quando il sito è molto occupato: riprova tra qualche minuto.",
        undo_incomplete:
          "Il ripristino si è fermato a metà e non è stato possibile annullarlo da solo, quindi il sito non è disponibile per i visitatori. Ripristina di nuovo un backup per ripararlo; se non funziona nemmeno così, contatta il tuo fornitore di hosting.",
        definer_missing:
          "Questo backup contiene viste, trigger o procedure del database che appartengono a un utente del database eliminato dopo il backup. Ricrea quell'utente con lo stesso nome nella scheda Database e riprova; se non sai quale sia, contatta il tuo fornitore di hosting.",
        address_not_updated:
          "Non è stato possibile reimpostare l'indirizzo del sito: link e accesso potrebbero puntare a un vecchio indirizzo. Contatta il tuo fornitore di hosting.",
        panel_dump_failed:
          "Qualcosa non ha funzionato sul server. Riprova più tardi; se succede di nuovo, contatta il tuo fornitore di hosting.",
        panel_dump_tool_missing:
          "Qualcosa non ha funzionato sul server. Riprova più tardi; se succede di nuovo, contatta il tuo fornitore di hosting.",
        panel_dump_missing:
          "Qualcosa non ha funzionato sul server. Riprova più tardi; se succede di nuovo, contatta il tuo fornitore di hosting.",
        site_not_started:
          "I file e i database del sito sono tornati, ma il sito non è ripartito. Contatta il tuo fornitore di hosting.",
      } satisfies Record<BackupProblem, string>,
      copyProblem: {
        unreachable:
          "Lo spazio dove sono salvati i backup non è raggiungibile. Riprova più tardi; se continua, contatta il tuo fornitore di hosting.",
        tls_failed:
          "La connessione sicura con lo spazio dei backup non è riuscita. Contatta il tuo fornitore di hosting.",
        wrong_region:
          "Lo spazio dei backup non è impostato correttamente. Contatta il tuo fornitore di hosting.",
        auth_failed:
          "Lo spazio dei backup ha rifiutato l'accesso. Contatta il tuo fornitore di hosting.",
        bucket_missing:
          "Lo spazio dei backup non esiste più. Contatta il tuo fornitore di hosting.",
        write_denied:
          "Non abbiamo il permesso di usare lo spazio dei backup. Contatta il tuo fornitore di hosting.",
        wrong_key:
          "Questo backup è protetto da un'altra chiave e non si può leggere. Contatta il tuo fornitore di hosting.",
        key_file_missing:
          "Sul server la chiave che protegge i backup manca o non è valida. Contatta il tuo fornitore di hosting.",
        tool_unavailable:
          "Il server non è riuscito ad avviare l'operazione. Riprova tra qualche minuto; se continua, contatta il tuo fornitore di hosting.",
        no_space:
          "Sul server non c'è abbastanza spazio libero per farlo. Contatta il tuo fornitore di hosting.",
        database_dump_failed:
          "Non siamo riusciti a leggere o scrivere i database del sito. Riprova tra qualche minuto; se succede di nuovo, contatta il tuo fornitore di hosting.",
        files_unreadable:
          "Alcuni file del sito non si sono potuti leggere o scrivere. Controlla i permessi nella scheda File oppure contatta il tuo fornitore di hosting.",
        repository_locked:
          "Era in corso un altro backup di questo sito. Riprova tra qualche minuto.",
        timeout:
          "Ci è voluto troppo tempo ed è stato fermato. Riprova più tardi; se succede di nuovo, contatta il tuo fornitore di hosting.",
        interrupted: "Si è interrotto perché il server si è riavviato. Riprova.",
        other:
          "Qualcosa non ha funzionato. Riprova; se succede di nuovo, contatta il tuo fornitore di hosting.",
        site_busy: "Il sito stava completando un'altra modifica. Riprova tra qualche minuto.",
        restore_prepare_failed:
          "Non è stato possibile preparare il backup per il ripristino, quindi non è cambiato nulla. Riprova; se succede di nuovo, contatta il tuo fornitore di hosting.",
        switch_undone:
          "L'ultimo passaggio del ripristino non è stato completato, quindi tutto è stato rimesso com'era. Può succedere quando il sito è molto occupato: riprova tra qualche minuto.",
        undo_incomplete:
          "Il ripristino si è fermato a metà e non è stato possibile annullarlo da solo, quindi il sito non è disponibile per i visitatori. Ripristina di nuovo un backup per ripararlo; se non funziona nemmeno così, contatta il tuo fornitore di hosting.",
        definer_missing:
          "Questo backup contiene viste, trigger o procedure del database che appartengono a un utente del database eliminato dopo il backup. Ricrea quell'utente con lo stesso nome nella scheda Database e riprova; se non sai quale sia, contatta il tuo fornitore di hosting.",
        address_not_updated:
          "Non è stato possibile reimpostare l'indirizzo del sito: link e accesso potrebbero puntare a un vecchio indirizzo. Contatta il tuo fornitore di hosting.",
        panel_dump_failed:
          "Qualcosa non ha funzionato sul server. Riprova più tardi; se succede di nuovo, contatta il tuo fornitore di hosting.",
        panel_dump_tool_missing:
          "Qualcosa non ha funzionato sul server. Riprova più tardi; se succede di nuovo, contatta il tuo fornitore di hosting.",
        panel_dump_missing:
          "Qualcosa non ha funzionato sul server. Riprova più tardi; se succede di nuovo, contatta il tuo fornitore di hosting.",
        site_not_started:
          "I file e i database del sito sono tornati, ma il sito non è ripartito. Contatta il tuo fornitore di hosting.",
      } satisfies Record<BackupProblem, string>,
      restore: {
        button: "Ripristina",
        title: "Ripristinare il backup del {date}?",
        body: "Tutti i file e tutti i database di questo sito tornano com'erano il {date}. Tutto ciò che è cambiato da allora (contenuti, ordini, commenti, file caricati o modificati) va perso per sempre e non si può recuperare.",
        unavailable:
          "Verso la fine, per qualche secondo, i visitatori vedono un messaggio che il sito è temporaneamente non disponibile.",
        lostDatabases:
          "Un database eliminato nel frattempo torna senza i suoi utenti: ridai l'accesso dalla scheda Database.",
        backupFirst:
          "Per conservare una copia del sito com'è adesso, annulla e usa prima «Fai un backup adesso».",
        typeName: "Per confermare, scrivi il nome del sito {name}",
        cancel: "Annulla",
        confirm: "Ripristina questo backup",
        starting: "Avvio\u2026",
        wrongName: "Il nome non corrisponde a questo sito. Scrivilo esattamente come è indicato.",
        running:
          "Ripristino del backup del {date} in corso\u2026 Può richiedere diversi minuti; verso la fine il sito non è disponibile per qualche secondo. Puoi lasciare questa pagina.",
        done: "Il sito è stato ripristinato al backup del {date}.",
        doneAddressNotSet:
          "Il sito è stato ripristinato al backup del {date}, ma non siamo riusciti a reimpostarne l'indirizzo: link e accesso potrebbero puntare a un vecchio indirizzo. Contatta il tuo fornitore di hosting.",
        failed: "Il ripristino non è avvenuto e il sito è esattamente com'era.",
      },
      download: {
        prepare: "Prepara il download",
        preparing: "In preparazione\u2026 Puoi lasciare questa pagina.",
        fetch: "Scarica",
        readyUntil: "Pronto fino alle {time}",
        warning:
          "Questo file contiene tutti i file del sito e i suoi database, comprese le loro password. Conservalo in un posto sicuro e non condividerlo.",
        onlyOne:
          "Per ogni sito si tiene un solo download: prepararne un altro elimina quello pronto.",
        gone: "Questo download non è più disponibile. Preparalo di nuovo.",
        failed: "Non è stato possibile preparare il download.",
        fetchFailed:
          "Il download non è partito. Attendi un minuto e riprova; se succede di nuovo, preparalo di nuovo.",
      },
      errors: {
        notReady: "Il sito non è ancora pronto: riprova quando la sua configurazione è finita.",
        ORGANIZATION_SUSPENDED:
          "Il tuo account è sospeso: non è possibile fare backup. Contatta il tuo fornitore di hosting.",
        stillRunning:
          "Il backup sta richiedendo più tempo del solito e continua da solo. Il sito resta online; ricarica questa pagina più tardi per vedere il risultato.",
        uncertain:
          "Non abbiamo potuto confermare l'avvio del backup. Attendi un minuto e ricarica questa pagina prima di riprovare.",
        tooMany:
          "Per questo sito sono già stati avviati 6 tra backup, ripristini, download e aggiornamenti di WordPress nell'ultima ora. Puoi avviarne un altro alle {time}.",
        uncertainAction:
          "Non abbiamo potuto confermare che la richiesta sia arrivata. Attendi un minuto e ricarica questa pagina prima di riprovare.",
        stillWorking:
          "Ci vuole più tempo del solito e prosegue da solo. Ricarica questa pagina più tardi per vedere il risultato.",
      },
    },
    wordpress: {
      title: "WordPress",
      notAvailable: "Gli strumenti per WordPress non sono disponibili su questo server. Chiedi al tuo amministratore.",
      loadFailed: "Non siamo riusciti a caricare i dettagli di WordPress. Ricarica la pagina tra poco.",
      header: {
        version: "WordPress {version}",
        versionUnknown: "Versione di WordPress non nota",
        checkedAt: "Ultimo controllo: {date}",
        notChecked: "Non ancora controllato",
        checkNow: "Controlla ora",
        checking: "Controllo in corso…",
      },
      notices: {
        notCheckedYet:
          "Non abbiamo ancora controllato questo sito. Premi «Controlla ora» per vedere le versioni e gli aggiornamenti disponibili.",
        checking: "Stiamo controllando gli aggiornamenti di WordPress, dei plugin e dei temi…",
        updatesUnknown:
          "Non siamo riusciti a raggiungere wordpress.org, quindi non sappiamo se esistono aggiornamenti. Le versioni qui sotto sono quelle installate. Premi «Controlla ora» più tardi.",
        upToDate: "È tutto aggiornato.",
        checkFailed: "Il controllo non è terminato. Premi «Controlla ora» per riprovare.",
        slow: "Ci vuole più tempo del solito. Prosegue da solo: ricarica la pagina più tardi per vedere il risultato.",
      },
      problem: {
        configBroken:
          "Il file delle impostazioni di WordPress (wp-config.php) non si carica, quindi non siamo riusciti a leggere il sito. Correggi il file nella scheda File o ripristina una copia da Backup, poi premi «Controlla ora».",
        databaseUnreachable:
          "Il database del sito non risponde, quindi non siamo riusciti a leggere il sito. Controlla la scheda Database, poi premi «Controlla ora».",
        notInstalled:
          "Non abbiamo trovato WordPress nei file del sito. Se l'hai spostato o rimosso, ripristina una copia da Backup, poi premi «Controlla ora».",
        other: "Questa volta non siamo riusciti a leggere il sito. Premi «Controlla ora» per riprovare.",
      },
      tables: {
        core: "WordPress",
        plugins: "Plugin",
        themes: "Temi",
        name: "Nome",
        status: "Stato",
        installed: "Installata",
        available: "Nuova versione",
        actions: "Azioni",
        current: "Aggiornato",
        unknown: "Non nota",
        emptyPlugins: "Nessun plugin installato.",
        emptyThemes: "Nessun tema installato.",
        update: "Aggiorna",
        updateLabel: "Aggiorna {name} alla versione {version}",
        updateAll: "Aggiorna tutto ({count})",
      },
      status: {
        active: "Attivo",
        inactive: "Non attivo",
        activeNetwork: "Attivo su tutti i siti",
        mustUse: "Sempre attivo",
        dropin: "Drop-in",
        parent: "Tema genitore",
      },
      admins: {
        title: "Amministratori",
        login: "Nome utente",
        empty: "Nessun amministratore trovato.",
        reset: "Reimposta password",
        resetLabel: "Reimposta la password di {login}",
      },
      update: {
        titleOne: "Aggiornare {name}?",
        titleCore: "Aggiornare WordPress?",
        titleAll: "Aggiornare tutto?",
        bodyOne: "{name} passa dalla versione {from} alla {to}.",
        bodyAll: "Verranno installati {count} aggiornamenti: prima WordPress, poi i plugin, poi i temi.",
        downtime: "Durante l'aggiornamento il sito potrebbe non essere raggiungibile per qualche istante.",
        backupTaken: "Prima viene fatta una copia del sito. Se qualcosa va storto, puoi ripristinarla dalla scheda Backup.",
        backupNone:
          "I backup non sono configurati su questo server, quindi prima non verrà fatta nessuna copia del sito. Se qualcosa va storto, non ci sarà una copia da ripristinare.",
        noAutoRestore: "Il pannello non annulla mai da solo un aggiornamento.",
        confirm: "Aggiorna",
        confirmAll: "Aggiorna tutto",
        cancel: "Annulla",
        starting: "Avvio in corso…",
      },
      progress: {
        title: "Aggiornamento in corso",
        backup: "Copia del sito in corso",
        backupSkipped: "Nessuna copia: i backup non sono configurati su questo server",
        update: "Installazione degli aggiornamenti",
        settle: "Chiusura e nuova lettura delle versioni",
        inspect: "Controllo degli aggiornamenti",
      },
      step: {
        done: "completato",
        running: "in corso",
        waiting: "in attesa",
        skipped: "saltato",
        failed: "non riuscito",
      },
      outcome: {
        title: "Ultimo aggiornamento",
        finishedAt: "Terminato il {date}",
        succeeded: "Aggiornamento terminato: tutto ciò che hai chiesto è stato aggiornato.",
        nothingToDo: "Non c'era niente da aggiornare.",
        orgUnreachable: "Non siamo riusciti a raggiungere wordpress.org, quindi non è stato aggiornato niente. Riprova più tardi.",
        configBroken:
          "Il file delle impostazioni di WordPress (wp-config.php) non si carica, quindi non è stato aggiornato niente. Correggilo nella scheda File, poi riprova.",
        databaseUnreachable:
          "Il database del sito non rispondeva, quindi non è stato aggiornato niente. Controlla la scheda Database, poi riprova.",
        notInstalled: "Non abbiamo trovato WordPress nei file del sito, quindi non è stato aggiornato niente.",
        backupFailed:
          "La copia del sito prima dell'aggiornamento non è riuscita, quindi non è stato aggiornato niente. Riprova più tardi; se succede ancora, chiedi al tuo amministratore.",
        itemsFailed: "Alcuni elementi non sono stati aggiornati: vedi l'elenco qui sotto. Controlla che il sito funzioni ancora.",
        itemUnknown:
          "Questo plugin o tema non è più presente sul sito. Non è stato modificato nulla. Premi «Controlla ora» per vedere l'elenco aggiornato.",
        interrupted: "L'aggiornamento è stato interrotto prima di qualsiasi modifica. Riprova.",
        outcomeUnknown:
          "Non sappiamo come è terminato l'aggiornamento. Controlla le versioni qui sotto e che il sito funzioni ancora.",
        failed: "L'aggiornamento non è riuscito. Controlla le versioni qui sotto, poi riprova.",
        backupTaken: "Nella scheda Backup c'è una copia di poco prima dell'aggiornamento, se devi tornare indietro.",
        backupSkipped: "Prima non è stata fatta nessuna copia, perché i backup non sono configurati su questo server.",
        item: "Elemento",
        before: "Prima",
        after: "Dopo",
        result: "Esito",
        updated: "Aggiornato",
        notUpdated: "Non aggiornato",
        type: { core: "WordPress", plugin: "Plugin", theme: "Tema" },
      },
      reset: {
        title: "Reimpostare la password di {login}?",
        body: "La password attuale smette subito di funzionare e {login} viene disconnesso da WordPress su tutti i dispositivi.",
        once: "La nuova password viene mostrata una sola volta.",
        confirm: "Reimposta password",
        cancel: "Annulla",
        resetting: "Reimpostazione in corso…",
        doneTitle: "Password reimpostata",
        done: "Fatto",
        created: {
          tempFor: "Password per {name}:",
          copy: "Copia",
          copied: "Copiata",
          copyUnavailable: "Qui non è possibile copiare. Seleziona la password e copiala a mano.",
          tempNote: "Consegnala alla persona che usa questo account. Potrà sceglierne una nuova in WordPress, alla voce Profilo.",
          tempOnce: "La mostriamo una sola volta: copiala ora. Se la perdi, reimposta di nuovo la password.",
        },
        failed: {
          configBroken:
            "La password non è stata cambiata: il file delle impostazioni di WordPress (wp-config.php) non si carica. Correggilo nella scheda File, poi riprova.",
          databaseUnreachable:
            "La password non è stata cambiata: il database del sito non risponde. Controlla la scheda Database, poi riprova.",
          notInstalled: "La password non è stata cambiata: non abbiamo trovato WordPress nei file del sito.",
          unknown:
            "Non siamo riusciti a confermare se la password è cambiata. Se la vecchia password non funziona più, reimpostala di nuovo.",
        },
      },
      errors: {
        notReady: "Il sito è in fase di preparazione o modifica. Riprova quando è pronto.",
        itemUnknown: "Questo elemento non è più presente sul sito. Premi «Controlla ora» per vedere l'elenco aggiornato.",
        adminUnknown:
          "Questa persona non è più un amministratore del sito. Premi «Controlla ora» per vedere l'elenco aggiornato.",
        uncertain: "Non siamo riusciti a confermare l'avvio. Aspetta un minuto e ricarica la pagina prima di riprovare.",
        suspended: "Il tuo account è sospeso: non è possibile controllare o modificare WordPress. Contatta il tuo fornitore di hosting.",
      },
      import: {
        title: "Importa un sito WordPress",
        loadFailed: "Non è stato possibile caricare la pagina di importazione. Ricarica la pagina tra poco.",
        filesUnknown: "Al momento non è possibile leggere i file inviati per l'importazione. Ricarica la pagina tra poco.",
        backupsLink: "Vai a Backup",
        card: {
          title: "Importa un sito",
          body: "Sposta qui un sito WordPress da un altro hosting: i suoi file (.zip) e l'esportazione del database.",
          start: "Avvia un'importazione",
          running: "È in corso un'importazione. Gli altri strumenti WordPress tornano disponibili al termine.",
          follow: "Segui l'importazione",
          last: "Ultima importazione ({date}): {result}",
          result: {
            imported: "il sito è stato importato.",
            nothing_changed: "si è fermata, non è cambiato nulla.",
            site_restored: "non è riuscita, il sito è stato riportato com'era.",
            undo_incomplete: "non è riuscita e il sito non è stato riportato del tutto com'era.",
          },
        },
        stepOf: "Passo {n} di 5",
        steps: {
          intro: "Prima di iniziare",
          archive: "File del sito (.zip)",
          dump: "Esportazione del database (.sql o .sql.gz)",
          confirm: "Controlla e conferma",
          run: "Importazione",
        },
        intro: {
          body: "L'importazione sostituisce file e database di questo sito con quelli che invii. Accessi, indirizzo, SFTP e backup restano invariati.",
          what: "Servono due file dal vecchio hosting: uno .zip della cartella del sito e un'esportazione .sql o .sql.gz del database. Ogni file può arrivare a 2 GB.",
        },
        slot: {
          empty: "Nessun file ancora.",
          choose: "Scegli un file",
          partial:
            "Una parte di questo file è stata ricevuta ({received}). Scegli di nuovo lo stesso file per riprendere da dove si è fermato, oppure un altro file per ricominciare.",
          filled: "Ricevuto: {size}.",
          replace: "Scegli un altro file per sostituirlo",
          wrongType: { archive: "Scegli un file .zip.", dump: "Scegli un file .sql o .sql.gz." },
        },
        pick: {
          label: "Oppure usa un file già presente sul sito (il suo percorso dalla cartella del sito)",
          use: "Usa questo file",
          invalid: "Scrivi un percorso dentro la cartella del sito, per esempio uploads/site.zip.",
          notFound: "Non c'è alcun file in quel percorso. Controlla il nome nella scheda File.",
          notAFile:
            "Quel percorso non è un file: non si possono usare una cartella o un collegamento. Scrivi il percorso del file stesso.",
          sftpWarning:
            "Un file caricato con SFTP può essere scaricato da chiunque ne conosca l'indirizzo finché non lo usi qui. Usandolo viene spostato fuori dalla cartella del sito: non compare più in File e «Scarta i file» lo elimina.",
        },
        discard: "Scarta i file",
        discardBusy: "Attendi che il file in invio sia arrivato, poi scarta i file.",
        discardDone: "Entrambi i file sono stati rimossi.",
        confirm: {
          replaces: "File e database del sito saranno sostituiti da quelli che hai inviato.",
          downtime: "Il sito non è disponibile per qualche minuto durante la sostituzione.",
          backupTaken: "Prima viene salvata una copia del sito. Puoi ripristinarla da Backup.",
          backupNone: "Non verrà salvata alcuna copia: i backup non sono configurati su questo server.",
          oldestCopy:
            "Questa copia rientra tra le tre copie conservate prima di un aggiornamento o di un'importazione, quindi la più vecchia potrebbe essere rimossa.",
          address: "L'indirizzo del sito importato viene cambiato con l'indirizzo di questo sito.",
          leftOut: "Questi file non vengono presi dallo .zip; il sito mantiene i propri: {list}.",
          undo: "Se l'importazione non riesce, il sito viene riportato com'era.",
          typeLabel: "Scrivi {name} per confermare",
          typeHint: "Scrivi il nome del sito per attivare questo pulsante.",
          go: "Sostituisci il mio sito",
          starting: "Avvio…",
          filesIncomplete: "Prima entrambi i file devono essere ricevuti completamente.",
        },
        progress: {
          title: "Importazione in corso… puoi lasciare questa pagina, l'importazione continua.",
          check: "Controlla i due file",
          backup: "Salva una copia del sito",
          backupSkipped: "Nessuna copia salvata: i backup non sono configurati su questo server",
          unpack: "Estrai i file del sito",
          database: "Carica l'esportazione del database",
          switch: "Sostituisci il sito",
          finish: "Pulisci e controlla il sito",
          unsettled: "L'importazione è in fase di completamento o di annullamento. Ricontrolla tra qualche minuto.",
          slow: "L'importazione è ancora in corso. Ricarica la pagina più tardi per vedere il risultato.",
        },
        outcome: {
          title: "Ultima importazione",
          finishedAt: "Terminata il {date}",
          imported: "Il sito è stato importato.",
          oldAddress: "Il vecchio indirizzo {address} è stato sostituito con l'indirizzo di questo sito.",
          tables: "Tabelle caricate: {count}.",
          leftOut: "Mantenuti da questo sito, non presi dallo .zip: {list}.",
          nothingChanged: "L'importazione si è fermata. Non è stato cambiato nulla: il sito è com'era.",
          siteRestored: "L'importazione non è riuscita durante la sostituzione. Il sito è com'era prima dell'importazione.",
          undoTaken:
            "Il {date} l'importazione non è riuscita e il sito non è stato riportato del tutto com'era. Per tornare indietro, ripristina da Backup la copia salvata subito prima di quell'importazione. Se da allora hai già ripristinato una copia, non serve altro.",
          undoNoCopy:
            "Il {date} l'importazione non è riuscita e il sito non è stato riportato del tutto com'era. Quell'importazione non aveva salvato una copia: ripristina una copia precedente da Backup oppure chiedi al tuo amministratore. Se da allora hai già ripristinato una copia, non serve altro.",
          errorNumber: "Numero di errore: {number}.",
          backup: {
            taken: "Prima dell'importazione è stata salvata una copia; la trovi in Backup.",
            skipped: "Prima di questa importazione non è stata salvata alcuna copia del sito.",
            failed: "Non è stato possibile salvare la copia prima dell'importazione.",
          },
        },
        reasons: {
          files_missing: "I file non erano più presenti. Inviali di nuovo.",
          earlier_import_unfinished:
            "Un'importazione precedente di questo sito non è riuscita e ha lasciato qui alcuni suoi resti. Ripristina una copia da Backup (questo li rimuove), poi importa di nuovo.",
          backup_failed:
            "Non è stato possibile salvare la copia prima dell'importazione. Riprova più tardi.",
          interrupted: "L'importazione è stata interrotta. Riprova.",
          timed_out:
            "L'importazione ha richiesto troppo tempo ed è stata fermata. Riprova; se succede di nuovo, chiedi al tuo amministratore.",
          unavailable: "Il server non è riuscito a eseguire l'importazione ora. Riprova tra qualche minuto.",
          other: "Qualcosa non ha funzionato. Riprova; se succede di nuovo, chiedi al tuo amministratore.",
          archive_not_zip: "I file del sito non sono uno .zip valido. Crea di nuovo l'archivio e invialo.",
          dump_not_sql: "L'esportazione del database non è un file di testo .sql (o .sql.gz). Esportala di nuovo in formato SQL.",
          archive_unsafe:
            "Lo .zip contiene collegamenti o percorsi che puntano fuori dalla cartella del sito. Crealo di nuovo solo dalla cartella del sito.",
          archive_limit:
            "Lo .zip contiene troppi file o è troppo grande una volta estratto. Rimuovi backup o cache dall'archivio e riprova.",
          archive_not_wordpress:
            "Nello .zip non è stato trovato un sito WordPress (mancano wp-includes e wp-admin). Comprimi la cartella che contiene wp-config.php.",
          disk_full: "Non c'è spazio sufficiente per l'importazione. Libera spazio o chiedi al tuo amministratore.",
          staging_unsafe:
            "L'importazione non è riuscita a preparare il suo spazio di lavoro tra i file del sito. Scarta entrambi i file e inviali di nuovo.",
          dump_unsafe:
            "Non è stato possibile leggere l'esportazione del database in modo sicuro. Scarta entrambi i file e inviali di nuovo.",
          dump_too_large:
            "L'esportazione del database è troppo grande una volta caricata. Elimina vecchie bozze e log dal vecchio sito ed esportalo di nuovo.",
          dump_incomplete: "L'esportazione del database è incompleta. Esportala di nuovo e invia il file intero.",
          dump_statement_unsupported:
            "Non è stato possibile caricare l'esportazione del database: sembra contenere un comando non consentito (come modifiche a utenti o permessi), oppure il caricamento si è interrotto. Esporta solo le tabelle e riprova.",
          dump_load_failed:
            "Non è stato possibile caricare l'esportazione del database. Il file potrebbe contenere un errore, oppure il caricamento si è interrotto. Esportala di nuovo e riprova; se succede di nuovo, chiedi al tuo amministratore.",
          dump_not_wordpress: "L'esportazione non contiene tabelle WordPress. Esporta il database del sito WordPress.",
          dump_ambiguous: "L'esportazione contiene più di un sito WordPress. Esporta solo quello che vuoi.",
          multisite_unsupported: "Le installazioni WordPress multisito non possono essere importate.",
          address_unsupported:
            "Non è stato possibile ricavare il vecchio indirizzo del sito dall'esportazione. Un'importazione richiede il vecchio sito alla radice del suo indirizzo, non in una sottocartella, e lo stesso dominio in «Indirizzo WordPress (URL)» e «Indirizzo sito (URL)» in Impostazioni, Generali. L'esportazione deve comprendere l'intero database, utenti del sito inclusi. Configura così il vecchio sito ed esporta di nuovo.",
          dump_objects_unsupported:
            "L'esportazione contiene procedure, trigger, viste o eventi, che non possono essere importati. Esporta solo le tabelle.",
          dump_names_unsupported:
            "L'esportazione usa nomi di tabelle o database che non possono essere importati. Esporta solo le tabelle di questo sito.",
          dump_too_many_tables:
            "L'esportazione del database contiene più di 1.000 tabelle, più di quante un'importazione possa accettarne. Esporta solo le tabelle di questo sito.",
          site_objects_unsupported:
            "Il database attuale di questo sito contiene elementi che un'importazione non può mettere da parte (viste, trigger, procedure o eventi). Rimuovili, per esempio dalla scheda Database, poi importa di nuovo.",
          address_rewrite_failed:
            "Non è stato possibile sostituire il vecchio indirizzo nei dati importati. Riprova; se succede di nuovo, chiedi al tuo amministratore.",
          site_check_failed:
            "Il sito importato non ha risposto correttamente. Verifica che il vecchio sito funzioni ed esporta di nuovo.",
        },
        reasonsAtLine: {
          dump_statement_unsupported:
            "Non è stato possibile caricare l'esportazione del database alla riga {line}: sembra contenere un comando non consentito (come modifiche a utenti o permessi), oppure il caricamento si è interrotto. Esporta solo le tabelle e riprova.",
          dump_load_failed:
            "Non è stato possibile caricare l'esportazione del database alla riga {line}. Il file potrebbe contenere un errore in quel punto, oppure il caricamento si è interrotto. Esportala di nuovo e riprova; se succede di nuovo, chiedi al tuo amministratore.",
        },
        errors: {
          importRunning: "È già in corso un'importazione di questo sito. Attendi che finisca.",
          uncertain: "Non abbiamo potuto confermare che sia stato fatto. Ricarica la pagina per vedere a che punto è prima di riprovare.",
          permission:
            "Puoi seguire questa pagina ma non modificarla. Chiedi a un proprietario dell'account il permesso di modificare il sito.",
          tooMany:
            "Per questo sito sono state avviate troppe azioni pesanti (copie, ripristini, aggiornamenti o importazioni) in poco tempo. Puoi avviare l'importazione alle {time}.",
        },
      },
    },
  },
  admin: {
    nav: {
      label: "Amministrazione",
      server: "Server",
      sites: "Siti",
      users: "Utenti",
      mail: "Email",
      backups: "Backup",
      audit: "Registro attività",
    },
    hosts: {
      title: "Server",
      subtitle: "Server dedicati registrati e relativo stato.",
      total: "Server registrati",
      totalNote: "Modalità dedicata attiva",
      cpu: "CPU allocabile",
      cpuNote: "Risorse hardware verificate",
      vcpu: "{n} vCPU",
      mode: "Modalità hosting",
      modeValue: "100% dedicata",
      modeNote: "La modalità condivisa non è disponibile",
      listTitle: "Server registrati",
      listHint: "Stato, indirizzo IPv4 e parametri di isolamento.",
      colHost: "Server",
      colIp: "Indirizzo IPv4",
      colStatus: "Stato",
      colMode: "Modalità",
      colHardware: "Hardware",
      colSecurity: "Revisione sicurezza",
      colActions: "Azioni",
      empty: "Nessun server registrato.",
      reviewed: "Verificato",
      pending: "In attesa",
      detail: "Dettaglio",
      ram: "{n} GB RAM",
    },
    host: {
      back: "Torna ai server",
      hostLine: "Hostname: {hostname} • IPv4: {ip}",
      backend: "backend: {backend}",
      tabOverview: "Panoramica e telemetria",
      tabAllocations: "Allocazioni",
      tabBoundaries: "Servizi e sicurezza",
      cpuTitle: "CPU ({n} vCPU)",
      cpuLive: "Carico in tempo reale • {n} millicore totali",
      cpuStatic: "{n} millicore fisici (telemetria non attiva)",
      ramTitle: "Memoria RAM",
      storageTitle: "Storage primario",
      usedOf: "{used} usati su {total}",
      bytesTotal: "{n} byte totali",
      storageNote: "Storage NVMe locale isolato",
      telemetryTitle: "Telemetria di sistema e stato dei servizi",
      telemetryHint: "Metriche raccolte da hp-host-agent e heartbeat dei servizi sul canale IPC firmato.",
      updatedAt: "Aggiornato: {time}",
      kernel: "Versione kernel Linux:",
      uptime: "Uptime:",
      docker: "Docker Engine API (v1.45+):",
      reachable: "Raggiungibile",
      unreachable: "Non raggiungibile",
      noTelemetry: "Telemetria in tempo reale non disponibile con runtimeBackend={backend}.",
      noHeartbeat: "Nessun heartbeat registrato",
      heartbeat: "v{version} • visto alle {time}",
      waiting: "in attesa",
      disabled: "disabilitato",
      configTitle: "Configurazione e hardware",
      configHint: "Dati identificativi registrati nel piano di controllo.",
      uniqueId: "Identificativo univoco:",
      ipv6: "Indirizzo IPv6:",
      notConfigured: "Non configurato",
      securityReview: "Revisione di sicurezza:",
      approved: "Approvato",
      notVerified: "Non verificato",
      sharedApproval: "Modalità condivisa:",
      sharedDisabled: "Disabilitata",
      allocTitle: "Clienti allocati su questo server",
      allocHint: "In modalità dedicata, al più un cliente attivo può occupare il server.",
      allocId: "ID allocazione",
      allocOrg: "Organizzazione",
      allocStatus: "Stato",
      allocScope: "Ambito",
      allocCreated: "Creata il",
      allocEmpty: "Nessuna allocazione attiva: il server è libero.",
      exclusive: "Esclusivo",
      shared: "Condiviso",
      executorTitle: "Docker Executor (hp-docker-executor)",
      agentTitle: "Host Agent (hp-host-agent)",
      runtimeActive: "Runtime attivo ({backend})",
      runtimePlanned: "Previsto in una fase successiva",
      executorBody:
        "Servizio non-root con isolamento dei container (CapDrop: ALL, no-new-privileges, una rete dedicata per sito) e ingress Traefik senza accesso a docker.sock.",
      agentBody:
        "Nessuna shell arbitraria. Accetta solo le azioni di manutenzione pre-approvate e i profili nftables statici.",
    },
    audit: {
      title: "Registro attività",
      subtitle: "Cronologia di ogni modifica autorevole effettuata sulla piattaforma.",
      cardTitle: "Eventi di sicurezza e operazioni di sistema",
      cardHint: "Gli eventi sono in sola aggiunta: non possono essere modificati né cancellati.",
      filterOrg: "Filtra per ID organizzazione...",
      filterAction: "Filtra per azione (es. host.mode.update)...",
      colTime: "Data e ora",
      colActor: "Attore",
      colAction: "Azione",
      colOrg: "Organizzazione",
      colTarget: "Destinatario",
      colDetails: "Dettagli",
      empty: "Nessun evento corrisponde ai filtri.",
      system: "sistema",
    },
    actions: {
      networkError: "Errore di comunicazione con il server.",
      modeRejected: "Passaggio alla modalità condivisa rifiutato dalle policy.",
      modeUnexpected: "Modalità aggiornata (inatteso: la modalità condivisa è chiusa).",
      modeReason: "Verifica automatica dalla console amministratore",
      maintReason: "Manutenzione '{action}' dalla console amministratore",
      secReason: "Verifica sicurezza '{policy}' dalla console amministratore",
      maintRejected: "Manutenzione rifiutata oppure Host Agent disabilitato.",
      secRejected: "Operazione di sicurezza rifiutata oppure runtime disabilitato.",
      maintTitle: "Manutenzione server: {label} ({action})",
      secTitle: "Sicurezza server: {label} ({policy})",
      outcome: "Esito Host Agent: [{code}]",
      policyResponse: "Risposta policy: [{code}]",
      gatingTitle: "Test della modalità condivisa",
      gatingHint: "Chiede il passaggio a modalità condivisa: la piattaforma deve rifiutarlo (409 SHARED_MODE_GATED).",
      gatingButton: "Prova passaggio a condivisa",
      maintSectionTitle: "Manutenzione del server (hp-host-agent)",
      maintSectionHint:
        "Esegue comandi pre-approvati in modo asincrono (202 Accepted). Ogni azione fuori elenco viene rifiutata (403 HOST_POLICY_DENIED).",
      run: "Esegui",
      forbiddenTest: "Prova azione non consentita (kernel_patch_drain): deve essere rifiutata con 403 HOST_POLICY_DENIED.",
      forbiddenButton: "Prova kernel_patch_drain",
      forbiddenLabel: "Prova azione vietata",
      secSectionTitle: "Sicurezza del server e firewall nftables",
      secSectionHint: "Applica o verifica profili statici certificati tramite Host Agent, con chiave di idempotenza.",
      runPolicy: "Avvia policy",
      collectDiagnostics: {
        label: "Raccogli diagnostica",
        description: "Istantanea di carico, memoria, filesystem e cgroups v2",
      },
      verifyStorage: {
        label: "Verifica storage",
        description: "Controlla permessi 0750/0700 e opzioni di mount delle cartelle gestite",
      },
      refreshInventory: {
        label: "Aggiorna inventario hardware",
        description: "Rileva CPU logiche, RAM, storage e architettura",
      },
      verifyFirewall: {
        label: "Verifica firewall di base",
        description: "Controlla il ruleset nftables attivo",
      },
      applyFirewall: {
        label: "Applica profilo nftables (22/80/443)",
        description: "Applica il profilo statico dedicato, verificato tramite hash",
      },
    },
    operation: {
      defaultTitle: "Operazione asincrona",
      status: {
        queued: "In coda",
        processing: "In esecuzione",
        accepted: "Accettata dal servizio",
        reconciling: "In riconciliazione",
        succeeded: "Completata",
        failed: "Fallita",
        cancelled: "Annullata",
        unknown: "Stato indeterminato",
      },
      step: {
        pending: "In attesa",
        running: "In corso",
        succeeded: "Completato",
        failed: "Fallito",
        cancelled: "Annullato",
        skipped: "Saltato",
        unknown: "Verifica in sola lettura",
      },
      idLine: "ID operazione: {id}",
      resource: " • Risorsa: {id}",
      dismiss: "Chiudi pannello operazione",
      unknownTitle: "Recupero da stato indeterminato",
      unknownBody:
        "L'operazione ha subito un'interruzione o un timeout dopo l'invio ed è nello stato unknown. Il blocco esclusivo resta attivo: il riconciliatore legge lo stato osservato senza rieseguire la richiesta.",
      errorTitle: "Errore operazione: [{code}]",
      errorFallback: "L'esecuzione asincrona non è andata a buon fine.",
      pollTitle: "Avviso sull'operazione",
      pollFailed: "Impossibile aggiornare lo stato dell'operazione.",
      pollOffline: "Connessione temporaneamente non disponibile.",
      loading: "Lettura dello stato iniziale...",
      noSteps: "Operazione registrata ({status}). Nessun passaggio dettagliato.",
    },
    sites: {
      title: "Siti",
      subtitle: "Tutti i siti WordPress di questo server e a chi appartengono.",
      create: "Crea sito",
      createTitle: "Crea un sito",
      createHint: "Il sito viene preparato in pochi minuti. Compare nel pannello del proprietario appena viene assegnato.",
      colName: "Nome",
      colDomain: "Indirizzo web",
      colOwner: "Proprietario",
      colPhp: "PHP",
      colStatus: "Stato",
      colActions: "Azioni",
      owner: "Proprietario",
      unassigned: "Non assegnato",
      unassignedOption: "Non ancora assegnato",
      customerOption: "{name} ({email})",
      changeOwner: "Cambia proprietario",
      changeOwnerTitle: "Cambia il proprietario di {site}",
      moveTo: "{site} passerà a {owner}. Lo vedrà e lo gestirà dal suo pannello. Il sito si riavvia per qualche secondo.",
      moveToNone: "Il cliente non vedrà più questo sito.",
      moveFrom: "{current} non lo vedrà e non lo gestirà più.",
      wpLogins: "Gli accessi di amministrazione WordPress non cambiano e restano validi per il nuovo proprietario: reimpostali da WP Admin se serve.",
      confirmMove: "Cambia proprietario",
      retry: "Riprova",
      delete: "Elimina",
      cancel: "Annulla",
      working: "Operazione in corso...",
      accepted: "Fatto. La modifica è in corso; ricarica tra un minuto per vedere il nuovo stato.",
      empty: "Nessun sito per ora.",
      loadError: "Non è stato possibile caricare i siti. Ricarica la pagina tra un minuto.",
      actionsFor: "Azioni per {name}",
      domains: "Domini",
      domainsTitle: "Domini di {site}",
      domainsBack: "Torna ai siti",
      alertsTitle: "Avvisi sui certificati",
      alertsExpiring: "{host} ({site}): il certificato scade il {date} e non si \u00e8 rinnovato",
      alertsNotIssued: "{host} ({site}): nessun certificato \u2014 {problem}",
      alertsPanelExpiring: "Indirizzo del pannello {host}: il certificato scade il {date}",
      alertsProblem: { rate_limited: "limite di Let's Encrypt raggiunto", port_80_blocked: "porta 80 non raggiungibile da internet", not_pointing: "il nome raggiunge un altro server", caa_blocked: "un record CAA blocca Let's Encrypt", other: "emissione non riuscita" },
    },
    mail: {
      title: "Posta in uscita",
      subtitle: "L'account email che i tuoi siti usano per inviare messaggi come conferme di prenotazione e moduli di contatto.",
      settingsTitle: "Account email",
      host: "Nome del server",
      port: "Porta",
      username: "Nome utente",
      password: "Password",
      passwordKeep: "Lascia vuoto per mantenere la password attuale",
      passwordIs: "Password: {state}",
      passwordSet: "impostata",
      passwordNotSet: "non impostata",
      senderDomain: "Dominio mittente",
      senderHint: "I messaggi partono come noreply@ questo dominio.",
      domainHint: "Presso il tuo fornitore di posta verifica {domain} e pubblica i record SPF e DKIM che ti fornisce. Senza, i messaggi possono finire nella posta indesiderata.",
      save: "Salva impostazioni",
      saving: "Salvataggio\u2026",
      saved: "Salvato. L'invio della posta su questo server si sta aggiornando.",
      remove: "Rimuovi",
      removeTitle: "Rimuovere la posta in uscita?",
      removeConfirm: "I tuoi siti smetteranno di inviare email, quindi conferme di prenotazione e moduli di contatto non arriveranno finch\u00e9 non la configuri di nuovo.",
      cancel: "Annulla",
      removing: "Rimozione\u2026",
      statusTitle: "Stato",
      starting: "Avvio dell'invio della posta su questo server\u2026",
      notStarted: "L'invio della posta non è ancora partito. Salva di nuovo le impostazioni; se non parte, controlla la pagina Server del pannello.",
      running: "In funzione",
      notRunning: "Non in funzione",
      unknown: "Sconosciuto",
      sentLast24h: "Inviati nelle ultime 24 ore: {count}",
      notConfigured: "La posta in uscita non è configurata. Inserisci i dati dell'account qui sopra e salva.",
      testTitle: "Invia un'email di prova",
      testTo: "Invia a",
      testSend: "Invia email di prova",
      testSending: "Invio\u2026",
      testAmbiguous: "L'email di prova potrebbe essere stata inviata. Controlla la casella di posta prima di riprovare.",
      failuresTitle: "Problemi recenti",
      noFailures: "Nessun problema nelle ultime 24 ore.",
      colWhen: "Quando",
      colTo: "A",
      colState: "Stato",
      colProblem: "Problema",
      state: { deferred: "In attesa", bounced: "Rifiutata" },
      field: {
        host_invalid: "Inserisci il nome del server del fornitore, ad esempio smtp.example.com. Gli indirizzi IP non si possono usare, perché la connessione sicura viene verificata sul nome.",
        username_invalid: "Inserisci il nome utente del tuo fornitore di posta, senza spazi né due punti.",
        password_invalid: "Inserisci di nuovo la password: massimo 256 caratteri, senza a capo e senza spazi all'inizio o alla fine.",
        sender_domain_invalid: "Inserisci il dominio verificato presso il tuo fornitore di posta, ad esempio hotel.it.",
        password_required: "Inserisci la password dell'account email.",
        not_configured: "Configura prima la posta in uscita, poi invia una prova.",
      },
      outcome: {
        sent: "Consegnata al fornitore di posta. Controlla la casella di {to}.",
        deferred: "Il fornitore di posta non l'ha ancora accettata. Resta in coda e verrà ritentata; leggi il problema qui sotto per risolverlo.",
        bounced: "Il fornitore di posta l'ha rifiutata. Leggi il problema qui sotto, risolvilo e poi invia un'altra prova.",
        pending: "Invio ancora in corso. Controlla i Problemi recenti tra un minuto.",
      },
      problem: {
        auth_failed: "Il fornitore ha rifiutato nome utente o password. Controllali con il tuo fornitore di posta e salva di nuovo.",
        unreachable: "Questo server non raggiunge {host} sulla porta {port}. Controlla nome e porta, e che il tuo fornitore cloud non blocchi la porta {port} in uscita.",
        tls_failed: "La connessione sicura con {host} non è riuscita o il certificato non corrisponde al nome. Controlla il nome del server con il fornitore; usa la 587, o la 465 se la richiede.",
        credentials_missing: "Il pannello non ha ancora passato la password al servizio di posta. Attendi un minuto; se persiste, salva di nuovo le impostazioni.",
        rejected: "Il fornitore ha rifiutato questo messaggio. Leggi il dettaglio, poi controlla il destinatario o il dominio mittente con il fornitore.",
        other: "Qualcosa è andato storto durante l'invio. Leggi il dettaglio; se si ripete, contatta il tuo fornitore di posta.",
      },
    },
    backups: {
      title: "Backup",
      subtitle: "Dove e quando salvare i backup notturni dei siti.",
      keyWarning:
        "La chiave che cifra i backup è il file /etc/hosting-panel/backup.key su questo server. Copiala subito in un posto sicuro fuori dal server: se il server va perso senza questa chiave, nessun backup potrà più essere letto, da nessuno. Anche la copia del pannello è cifrata con questa chiave: senza di essa il pannello non può essere riportato su un nuovo server. La copia del pannello contiene anche la chiave di tutte le password salvate: chi ha questo file e l'accesso allo storage può leggerle, quindi tieni il file segreto come una password.",
      panel: {
        never: "Copia del pannello (account, siti e impostazioni): non ancora fatta. Viene fatta ogni notte dopo i backup dei siti.",
        made: 'Copia del pannello (account, siti e impostazioni): fatta il {date}. Se questo server va perso, la sezione "Il server è perso" del README spiega come riportare il pannello con questa copia.',
        failed: "Copia del pannello (account, siti e impostazioni): l'ultimo tentativo ({date}) non è riuscito.",
      },
      panelProblem: {
        interrupted:
          "La copia si è interrotta perché l'executor si è riavviato; viene rifatta da sola la notte successiva e, se si interrompe di nuovo, controlla journalctl -u hp-docker-executor.",
        other:
          "Qualcosa non ha funzionato durante la copia; viene rifatta da sola la notte successiva e, se non riesce di nuovo, usa «Prova la connessione» in questa pagina e controlla journalctl -u hp-docker-executor.",
        repository_locked:
          "Lo storage era bloccato da un altro backup ancora in corso; la copia viene rifatta da sola la notte successiva e, se non riesce di nuovo, controlla journalctl -u hp-docker-executor.",
        timeout:
          "La copia ha superato il tempo massimo ed è stata fermata; viene rifatta da sola la notte successiva e, se non riesce di nuovo, controlla la velocità verso lo storage con «Prova la connessione» in questa pagina.",
        files_unreadable:
          "La copia non è riuscita a leggere il file del database del pannello; viene rifatta da sola la notte successiva e, se non riesce di nuovo, controlla lo spazio libero su disco e journalctl -u hp-docker-executor.",
        no_space:
          "Durante la copia sul server è finito lo spazio libero su disco; viene rifatta da sola la notte successiva, quindi libera spazio sul disco prima di allora (df -h).",
      },
      state: {
        notAvailable:
          "I backup non sono disponibili su questo tipo di installazione: servono un server installato con l'installer Linux (systemd).",
        neverSetUp:
          "Nessuna destinazione configurata: i backup non vengono fatti. Inserisci i dati del bucket S3 e salva.",
        working:
          "Destinazione configurata. I backup notturni partono alle {utc} UTC ({local} nel tuo fuso orario). Ultimo giro notturno: {date}.",
        nightlyNever: "non ancora partito",
        lastTestFailed: "L'ultima prova della connessione ({when}) non è riuscita:",
      },
      endpoint: "Endpoint S3",
      endpointHint:
        "Ad esempio https://s3.eu-central-1.amazonaws.com. Con http:// i backup restano cifrati, ma il traffico verso lo storage non è protetto: usalo solo in una rete privata.",
      region: "Regione",
      regionHint: "Per molti storage compatibili S3 va bene «us-east-1».",
      bucket: "Bucket",
      prefix: "Percorso nel bucket (facoltativo)",
      prefixHint: "Ad esempio «pannello/server1». Lascia vuoto per usare la radice del bucket.",
      accessKeyId: "Access key ID",
      secretAccessKey: "Secret access key",
      secretKeep: "Lascia vuoto per mantenere quella salvata",
      secretIs: "Secret access key salvata: {state}",
      secretSet: "sì",
      secretNotSet: "no",
      hour: "Ora del backup notturno",
      hourOption: "{utc} UTC ({local} nel tuo fuso orario)",
      retention: "Giorni di conservazione",
      retentionHint: "Da 1 a 365. Il backup riuscito più recente di ogni sito viene sempre tenuto.",
      changeWarning:
        "Cambiando endpoint, bucket o percorso il pannello dimentica i backup registrati finora e i clienti non li vedranno più. Nel bucket non viene cancellato nulla.",
      save: "Salva",
      saving: "Salvataggio\u2026",
      saved: "Impostazioni salvate.",
      field: {
        endpoint_invalid:
          "Inserisci un indirizzo http:// o https:// senza percorso, ad esempio https://s3.example.com. Non si può usare un indirizzo di questo stesso server (localhost).",
        region_invalid: "Usa solo lettere minuscole, numeri e trattini (massimo 64).",
        bucket_invalid:
          "Inserisci un nome del bucket di 3-63 caratteri: lettere minuscole, numeri, punti e trattini, senza due punti consecutivi.",
        prefix_invalid:
          "Percorso non valido: segmenti di lettere, numeri, punti, trattini e trattini bassi separati da /.",
        access_key_id_invalid:
          "Copia di nuovo l'access key ID dalla console del fornitore di storage, senza spazi prima o dopo.",
        secret_access_key_invalid:
          "Copia di nuovo la secret access key dalla console del fornitore di storage, senza spazi prima o dopo.",
        secret_access_key_required: "Inserisci la secret access key.",
        schedule_hour_invalid: "Scegli un'ora tra 0 e 23.",
        retention_days_invalid: "Inserisci un numero di giorni tra 1 e 365.",
      },
      testTitle: "Prova la connessione",
      testHelp:
        "Prova la destinazione salvata: scrive e cancella un piccolo file nel percorso indicato. Può richiedere fino a 30 secondi.",
      testButton: "Prova la connessione",
      testing: "Prova in corso\u2026",
      testSaveFirst: "Salva le impostazioni prima di provarle.",
      testAmbiguous: "Non sappiamo come è finita la prova. Ricarica la pagina e riprova.",
      outcome: { ok: "Funziona: il pannello può scrivere e cancellare nel bucket." },
      problem: {
        unreachable:
          "Impossibile raggiungere l'endpoint. Controlla l'indirizzo e che il server possa uscire verso quella porta.",
        tls_failed:
          "La connessione HTTPS all'endpoint non è riuscita: il certificato non è valido per quell'indirizzo. Controlla l'endpoint.",
        wrong_region:
          "Lo storage ha rifiutato la regione. Correggi la regione e salva di nuovo.",
        auth_failed:
          "Le chiavi di accesso sono state rifiutate. Controlla access key ID e secret access key.",
        bucket_missing:
          "Il bucket non esiste. Crealo nello storage oppure correggi il nome.",
        write_denied:
          "Le chiavi funzionano ma non possono scrivere o cancellare in quel percorso. Dai loro i permessi di scrittura e cancellazione.",
        wrong_key:
          "In questo percorso ci sono backup cifrati con un'altra chiave (un altro server o un backup.key diverso). Usa un altro percorso, oppure rimetti in /etc/hosting-panel/backup.key la chiave originale.",
        key_file_missing:
          "/etc/hosting-panel/backup.key manca o non è valido. Rimetti la copia che hai salvato fuori dal server. Solo se non ne esiste nessuna copia: elimina il file ed esegui hp-update per crearne uno nuovo (i backup fatti con la vecchia chiave non saranno leggibili).",
        tool_unavailable:
          "Il server non è riuscito ad avviare lo strumento di backup. Controlla la connessione a Internet del server e i log dell'executor (journalctl -u hp-docker-executor).",
        no_space:
          "Sul server non c'è abbastanza spazio libero per preparare i backup. Libera spazio sul disco e riprova.",
        database_dump_failed:
          "La copia dei database del sito non è riuscita. Controlla che MariaDB sia attivo e riprova.",
        files_unreadable:
          "Alcuni file del sito non sono leggibili dal backup. Controlla i permessi nella scheda File del sito e riprova.",
        repository_locked:
          "Un altro backup di questo sito era in corso. Riprova tra qualche minuto.",
        timeout:
          "Il backup ha superato il tempo massimo ed è stato fermato. Controlla la velocità verso lo storage e riprova.",
        interrupted:
          "Il backup si è interrotto perché l'executor si è riavviato. Usa «Riprova».",
        other:
          "Qualcosa non ha funzionato. Riprova; se si ripete controlla i log dell'executor (journalctl -u hp-docker-executor).",
        site_busy: "Il sito stava completando un'altra modifica. Riprova tra qualche minuto.",
        restore_prepare_failed:
          "Un ripristino non è riuscito a preparare la copia del sito; il sito non è stato toccato. Riprova il ripristino; se fallisce ancora, controlla i log dell'executor (journalctl -u hp-docker-executor).",
        switch_undone:
          "Un ripristino non ha completato l'ultimo passaggio e ha rimesso il sito com'era. Di solito una query lunga teneva occupato il database: riprova più tardi.",
        undo_incomplete:
          "Un ripristino si è fermato a metà e anche il suo annullamento non è riuscito: il sito risponde «temporaneamente non disponibile» finché un ripristino di questo sito non riesce. Il cliente può avviarne uno dalla scheda Backup del sito; ciò che il tentativo fallito ha lasciato viene rimosso dal primo ripristino riuscito. Se non riesce nemmeno quello, controlla journalctl -u hp-docker-executor.",
        definer_missing:
          "Il backup contiene viste, trigger o routine il cui utente del database non esiste più; il sito non è stato toccato. Ricrea l'utente con lo stesso nome e ripeti il ripristino.",
        address_not_updated:
          "Il ripristino è riuscito, ma l'impostazione dell'indirizzo del sito non è riuscita: i link potrebbero puntare a un vecchio indirizzo. Controlla i log dell'executor (journalctl -u hp-docker-executor) e reimposta il dominio principale del sito.",
        panel_dump_failed:
          "La copia del database del pannello non è riuscita. Controlla che PostgreSQL sia attivo (systemctl status postgresql) e i log dell'API (journalctl -u hp-api); la copia viene ritentata la notte successiva.",
        panel_dump_tool_missing:
          "La copia del pannello non ha potuto avviare pg_dump. Controlla che il pacchetto postgresql-18 sia installato (apt install postgresql-18); la copia viene ritentata la notte successiva.",
        panel_dump_missing:
          "La copia del pannello non ha potuto leggere il file del database. Controlla lo spazio libero su disco e journalctl -u hp-docker-executor; la copia viene ritentata la notte successiva.",
        site_not_started:
          "File e database sono tornati, ma il sito non è partito. Controlla i log dell'executor (journalctl -u hp-docker-executor) e riprova il ripristino.",
      } satisfies Record<BackupProblem, string>,
      removeButton: "Rimuovi destinazione",
      removeTitle: "Rimuovere la destinazione dei backup?",
      removeConfirm:
        "Nel bucket non viene cancellato nulla. I backup notturni si fermano e il pannello dimentica i backup registrati: i clienti non li vedranno più.",
      removeCancel: "Annulla",
      removeAction: "Rimuovi",
      removed: "Destinazione rimossa.",
      sitesTitle: "Stato per sito",
      sitesEmpty: "Nessun sito.",
      sitesTotal: "Ultimi backup di tutti i siti insieme: {size}.",
      sitesLoadFailed: "Non riusciamo a caricare lo stato dei siti. Ricarica la pagina.",
      columns: {
        site: "Sito",
        owner: "Cliente",
        lastSuccess: "Ultimo riuscito",
        lastAttempt: "Ultimo tentativo",
        state: "Stato",
        action: "Azioni",
        size: "Dimensione ultimo backup",
      },
      siteState: {
        never: "Mai",
        running: "In corso\u2026",
        succeeded: "Riuscito",
        failed: "Non riuscito",
      },
      runNow: "Fai un backup",
      retry: "Riprova",
      restore: {
        button: "Ripristina",
        title: "Ripristinare il sito dal backup del {date}?",
        body: "Ogni file e ogni database di questo sito torna com'era il {date}. Tutto ciò che è cambiato da allora va perso per sempre. Se di questo sito non resta nulla sul server, il pannello lo ricrea da questo backup.",
        unavailable: "Se il sito è online, verso la fine i visitatori vedono per qualche secondo che è temporaneamente non disponibile.",
        lostDatabases: "Un database eliminato da allora torna senza i suoi utenti: il cliente ridà gli accessi dalla scheda Database.",
        backupFirst: 'Se il sito è ancora su questo server e vuoi conservarlo com\'è ora, annulla e usa prima "Fai un backup".',
        typeName: "Per confermare, scrivi il nome del sito {name}",
        cancel: "Annulla",
        confirm: "Ripristina questo backup",
        starting: "Avvio\u2026",
        wrongName: "Il nome non corrisponde a questo sito. Inseriscilo esattamente come è indicato.",
        noCopy: "Questo sito non ha più un backup riuscito da ripristinare. Ricarica la pagina.",
        running: "Ripristino del backup del {date} in corso\u2026",
        done: "Ripristinato al backup del {date}.",
        failed: "Il ripristino del backup del {date} non è riuscito.",
      },
      errors: {
        notConfigured: "Prima configura e salva una destinazione.",
        notReady: "Il sito non è ancora pronto: riprova quando la configurazione è finita.",
      },
    },
    users: {
      title: "Utenti",
      subtitle: "Account della piattaforma: l'amministratore e il cliente.",
      create: "Crea account cliente",
      colName: "Utente",
      colRole: "Ruolo",
      colStatus: "Stato",
      col2fa: "Verifica in due passaggi",
      colActions: "Azioni",
      empty: "Nessun utente.",
      roleAdmin: "Amministratore",
      roleCustomer: "Cliente",
      active: "Attivo",
      disabled: "Disabilitato",
      twoFaOn: "Attiva",
      twoFaOff: "Non attiva",
      locked: "Bloccato fino alle {time}",
      mustChange: "Deve cambiare la password",
      resetPassword: "Reimposta password",
      resetTotp: "Reimposta 2FA",
      disable: "Disabilita",
      enable: "Abilita",
      actionsFor: "Azioni per {name}",
      confirmResetPassword: "Reimpostare la password di {name}? Verrà generata una password provvisoria.",
      confirmResetTotp: "Reimpostare la verifica in due passaggi di {name}?",
      confirmDisable: "Disabilitare {name}? Verrà disconnesso subito.",
      confirm: "Conferma",
      done: "Fatto.",
      tempTitle: "Password provvisoria",
      tempFor: "Password provvisoria per {name}",
      tempNote: "Condividila in modo sicuro; il cliente deve cambiarla al primo accesso.",
      tempOnce: "Viene mostrata una sola volta.",
      copy: "Copia",
      copied: "Copiata",
      copyUnavailable: "Copia non disponibile: seleziona e copia la password a mano.",
      close: "Chiudi",
      createTitle: "Crea account cliente",
      createHint: "Crea l'organizzazione e il suo proprietario con una password provvisoria.",
      orgName: "Nome organizzazione",
      ownerName: "Nome del proprietario",
      ownerEmail: "Email del proprietario",
      createSubmit: "Crea account",
      conflict: "Esiste già un account cliente.",
    },
  },
  notFound: {
    code: "Errore 404",
    title: "Pagina non trovata",
    body: "La pagina che cerchi non esiste oppure non hai i permessi per vederla.",
    back: "Torna alla pagina iniziale",
  },
  errors: {
    MAIL_RELAY_UNAVAILABLE: "L'invio della posta non è ancora attivo su questo server. Attendi un minuto e riprova; se persiste, salva di nuovo le impostazioni.",
    INVALID_CREDENTIALS: "Email o password non corrette. Controlla i dati e riprova.",
    ACCOUNT_LOCKED:
      "Troppi tentativi. Riprova tra 15 minuti oppure rivolgiti al tuo amministratore.",
    TOTP_INVALID: "Il codice di verifica non è corretto. Controlla l'app e inserisci il codice aggiornato.",
    ACCOUNT_SETUP_INCOMPLETE:
      "Il tuo account non è ancora pronto. Contatta il tuo amministratore per completare la configurazione.",
    PERMISSION_DENIED: "Non hai i permessi per questa operazione. Chiedi al tuo amministratore.",
    NOT_FOUND: "Non abbiamo trovato quello che cerchi. Torna indietro e riprova.",
    VALIDATION_ERROR: "Alcuni dati non sono validi. Controlla i campi evidenziati e riprova.",
    INTERNAL_ERROR: "Qualcosa è andato storto da parte nostra. Riprova tra qualche minuto.",
    RESOURCE_LOCKED: "Il sito sta completando un'altra modifica. Riprova tra qualche istante.",
    ALREADY_EXISTS: "Questo nome è già in uso. Scegline un altro.",
    generic: "Si è verificato un errore. Riprova; se il problema continua contatta l'assistenza.",
  },
} as const;
