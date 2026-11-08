export const it = {
  common: {
    save: "Salva",
    cancel: "Annulla",
    logout: "Esci",
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
  },
  shell: {
    productName: "Hosting Panel",
  },
  site: {
    title: "Siti",
  },
  admin: {
    usersTitle: "Utenti",
  },
  errors: {
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
    generic: "Si è verificato un errore. Riprova; se il problema continua contatta l'assistenza.",
  },
} as const;
