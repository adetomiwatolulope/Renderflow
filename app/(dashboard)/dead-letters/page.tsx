import type { Metadata } from "next";

import { DeadLetterView } from "./dead-letter-view";

export const metadata: Metadata = {
  title: "Dead letters — RenderFlow",
  description: "Read-only view of jobs that need operator attention",
};

export default function DeadLettersPage() {
  return <DeadLetterView />;
}
