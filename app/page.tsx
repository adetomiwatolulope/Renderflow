import { redirect } from "next/navigation";

/**
 * The job list is the screen an operator actually opens, so the root sends them
 * straight to it rather than leaving the Next.js starter page in place. The
 * dead-letter view stays reachable at /dead-letters.
 */
export default function Home() {
  redirect("/jobs");
}
