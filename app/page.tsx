import { redirect } from "next/navigation";
import { getSession } from "@/lib/auth";
import { homePath } from "@/lib/roles";

export const dynamic = "force-dynamic";

/** `/` is just a doorway: signed in goes to work, otherwise to the login page. */
export default async function HomePage() {
  const session = await getSession();
  redirect(session ? homePath(session.role) : "/login");
}
