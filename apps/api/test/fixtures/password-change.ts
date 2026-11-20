import { eq, users, type DatabaseClient } from "@hosting-panel/database";

/** Clears mustChangePassword, as the user's own password change would, so a test can use a temporary-password session on other routes. */
export async function skipPasswordChange(db: DatabaseClient["db"], email: string): Promise<void> {
  await db.update(users).set({ mustChangePassword: false }).where(eq(users.email, email));
}
