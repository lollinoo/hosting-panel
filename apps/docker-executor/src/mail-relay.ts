import { createHash } from "node:crypto";
import {
  MAIL_RELAY_IMAGE,
  MailRelayApplyRequestSchema,
  mailSenderAddress,
  type MailRelayApplyRequest,
} from "@hosting-panel/contracts";
import { SHARED_DB_CONFIG_SHA256_LABEL } from "./shared-database.js";
import { ExecutorCodedError } from "./traefik-config.js";

export const MAIL_RELAY_NETWORK_NAME = "hp_mail_net" as const;
export const MAIL_RELAY_SPOOL_VOLUME = "hp_mail_relay_spool" as const;
export const DEFAULT_MAIL_RELAY_SECRET_DIR = "/run/hosting-panel/mail-relay" as const;
export const MAIL_RELAY_SASL_FILE = "sasl_passwd" as const;

const MAIL_RELAY_MEMORY_BYTES = 134217728;
const SECRET_MOUNT_DIR = "/run/secrets/hp-mail";

export interface MailRelayContainerInput {
  readonly req: MailRelayApplyRequest;
  readonly myHostname: string;
  readonly secretDirHostPath: string;
}

/** Defence in depth: the values end up in a Postfix map line. Never echoes a value (it may be the password). */
function assertValidMailRelayRequest(req: MailRelayApplyRequest): void {
  const parsed = MailRelayApplyRequestSchema.safeParse(req);
  if (
    !parsed.success ||
    parsed.data.host !== req.host ||
    parsed.data.senderDomain !== req.senderDomain
  ) {
    throw new ExecutorCodedError("Invalid mail relay settings", "VALIDATION_ERROR");
  }
}

export function buildMailRelaySaslLine(req: MailRelayApplyRequest): string {
  assertValidMailRelayRequest(req);
  return `[${req.host}]:${String(req.port)} ${req.username}:${req.password}\n`;
}

export function buildMailRelayContainerPayload(input: MailRelayContainerInput) {
  const { req, myHostname, secretDirHostPath } = input;
  assertValidMailRelayRequest(req);
  if (secretDirHostPath.includes("docker.sock")) {
    throw new ExecutorCodedError(
      "Mounting docker.sock into the mail relay is strictly forbidden (TH-02)",
      "HOST_POLICY_DENIED",
    );
  }
  const Image = MAIL_RELAY_IMAGE;
  const Env = [
    `RELAYHOST=[${req.host}]:${String(req.port)}`,
    "ALLOW_EMPTY_SENDER_DOMAINS=1",
    "LOG_FORMAT=plain",
    `POSTFIX_myhostname=${myHostname}`,
    "POSTFIX_mynetworks=127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16",
    "POSTFIX_smtp_sasl_auth_enable=yes",
    `POSTFIX_smtp_sasl_password_maps=texthash:${SECRET_MOUNT_DIR}/${MAIL_RELAY_SASL_FILE}`,
    "POSTFIX_smtp_sasl_security_options=noanonymous",
    "POSTFIX_smtp_sasl_tls_security_options=noanonymous",
    "POSTFIX_smtp_tls_security_level=secure",
    `POSTFIX_smtp_tls_wrappermode=${req.port === 465 ? "yes" : "no"}`,
    "POSTFIX_local_header_rewrite_clients=permit_mynetworks",
    "POSTFIX_sender_canonical_classes=envelope_sender,header_sender",
    `POSTFIX_sender_canonical_maps=static:${mailSenderAddress(req.senderDomain)}`,
    "POSTFIX_smtpd_client_message_rate_limit=200",
    "POSTFIX_smtpd_client_event_limit_exceptions=127.0.0.0/8",
    "POSTFIX_anvil_rate_time_unit=3600s",
    "POSTFIX_smtpd_recipient_limit=100",
    "POSTFIX_message_size_limit=26214400",
  ];
  // The image turns an empty POSTFIX_* value into `postconf -#`, silently restoring the default.
  if (Env.some((e) => /^POSTFIX_[^=]+=\s*$/.test(e))) {
    throw new ExecutorCodedError("Mail relay setting must not be empty", "VALIDATION_ERROR");
  }
  const Binds = [
    `${secretDirHostPath}:${SECRET_MOUNT_DIR}:ro`,
    `${MAIL_RELAY_SPOOL_VOLUME}:/var/spool/postfix`,
  ];
  // Trimmed live (Task 9): SETUID/SETGID/DAC_OVERRIDE are fatal without; CHOWN lets the image reown the spool.
  const CapAdd = ["CHOWN", "DAC_OVERRIDE", "SETGID", "SETUID"];
  const configSha256 = createHash("sha256")
    .update(JSON.stringify({ Image, Env, Binds: [...Binds].sort(), CapAdd }))
    .digest("hex");

  return {
    Image,
    Env,
    Labels: {
      "io.hostingpanel.managed": "true",
      "io.hostingpanel.role": "mail_relay",
      [SHARED_DB_CONFIG_SHA256_LABEL]: configSha256,
    },
    HostConfig: {
      Privileged: false,
      CapDrop: ["ALL"],
      CapAdd,
      SecurityOpt: ["no-new-privileges:true"],
      PidsLimit: 128,
      NanoCpus: 500_000_000,
      Memory: MAIL_RELAY_MEMORY_BYTES,
      MemorySwap: MAIL_RELAY_MEMORY_BYTES,
      RestartPolicy: { Name: "unless-stopped" },
      LogConfig: { Type: "json-file", Config: { "max-size": "10m", "max-file": "3" } },
      NetworkMode: MAIL_RELAY_NETWORK_NAME,
      Binds,
    },
  } as const;
}
