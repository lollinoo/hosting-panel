import { z } from "zod";

export const SITE_SFTP_MAX_USERS = 10;
export const SftpUserNameSchema = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9]{1,16}$/, { message: "invalid_name" });
export const CreateSiteSftpUserRequestSchema = z.object({ name: SftpUserNameSchema }).strict();

export const SiteSftpUserDtoSchema = z
  .object({
    id: z.string(),
    username: z.string(),
    createdAt: z.iso.datetime({ offset: true }),
    passwordChangedAt: z.iso.datetime({ offset: true }),
  })
  .strict();

export const SiteSftpDtoSchema = z
  .object({
    available: z.boolean(),
    host: z.string().nullable(),
    port: z.number().int().min(1).max(65535).nullable(),
    hostKeyFingerprint: z.string().nullable(),
    users: z.array(SiteSftpUserDtoSchema).max(SITE_SFTP_MAX_USERS),
  })
  .strict();

export const SiteSftpUserCreatedDtoSchema = z
  .object({
    user: SiteSftpUserDtoSchema,
    temporaryPassword: z.string().min(20),
  })
  .strict();

export const SiteSftpPasswordResetDtoSchema = z
  .object({
    temporaryPassword: z.string().min(20),
  })
  .strict();

export type SiteSftpDto = z.infer<typeof SiteSftpDtoSchema>;
export type SiteSftpUserDto = z.infer<typeof SiteSftpUserDtoSchema>;
export type SiteSftpUserCreatedDto = z.infer<typeof SiteSftpUserCreatedDtoSchema>;
export type SiteSftpPasswordResetDto = z.infer<typeof SiteSftpPasswordResetDtoSchema>;
