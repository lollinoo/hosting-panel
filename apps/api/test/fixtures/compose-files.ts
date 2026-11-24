import { readFileSync } from "node:fs";

// The Compose files of the importer's own tests: the route is tested on the files the importer is tested on.
const FILES = "../../../../packages/policy-engine/test/fixtures/compose-import/";
const read = (name: string): string => readFileSync(new URL(`${FILES}${name}`, import.meta.url), "utf8");

/** WordPress with MariaDB: two tagged images, three generated secrets, a published port and a platform address variable. */
export const WORDPRESS_COMPOSE: string = read("wordpress-mariadb.yml");
export const WORDPRESS_COMPOSE_IMAGES: readonly string[] = ["wordpress:6.8-apache", "mariadb:11.4"];

/** A forum with its passwords written in the file. */
export const LITERAL_SECRETS_COMPOSE: string = read("literal-secrets.yml");
export const LITERAL_SECRETS: readonly string[] = [
  "correct-horse-battery-staple",
  "0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a6978",
  "abcdefghijklmnopqrstuvwxyz012345",
  "relay-pass-1234",
];

/** One service whose image already carries its digest: nothing to ask a registry. */
export const PINNED_COMPOSE = `services:
  web:
    image: ghcr.io/example/web:2.4@sha256:${"ab".repeat(32)}
    expose:
      - "8080"
`;
