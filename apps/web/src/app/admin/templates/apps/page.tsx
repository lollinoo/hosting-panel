import { redirect } from "next/navigation";

/** The one «Modelli» list lives at /admin/templates; this address stays for old links. */
export default function AdminAppTemplatesPage(): never {
  redirect("/admin/templates");
}
