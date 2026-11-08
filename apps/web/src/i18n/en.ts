import type { Messages } from "./index";

export const en: Messages = {
  common: {
    save: "Save",
    cancel: "Cancel",
    logout: "Log out",
    language: "Language",
    italian: "Italiano",
    english: "English",
  },
  login: {
    title: "Sign in",
    email: "Email",
    password: "Password",
    totp: "Verification code",
    submit: "Sign in",
  },
  account: {
    title: "My account",
  },
  shell: {
    productName: "Hosting Panel",
  },
  site: {
    title: "Sites",
  },
  admin: {
    usersTitle: "Users",
  },
  errors: {
    INVALID_CREDENTIALS: "Incorrect email or password. Check your details and try again.",
    ACCOUNT_LOCKED: "Too many attempts. Try again in 15 minutes or ask your administrator.",
    TOTP_INVALID: "That verification code isn't right. Check your app and enter the current code.",
    ACCOUNT_SETUP_INCOMPLETE:
      "Your account isn't ready yet. Contact your administrator to finish setting it up.",
    PERMISSION_DENIED: "You don't have permission to do this. Ask your administrator.",
    NOT_FOUND: "We couldn't find what you're looking for. Go back and try again.",
    VALIDATION_ERROR: "Some details aren't valid. Check the highlighted fields and try again.",
    INTERNAL_ERROR: "Something went wrong on our side. Please try again in a few minutes.",
    generic: "Something went wrong. Try again, and contact support if it keeps happening.",
  },
};
