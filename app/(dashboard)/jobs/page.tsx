import type { Metadata } from "next";

import { JobsView } from "./jobs-view";

export const metadata: Metadata = {
  title: "Jobs — RenderFlow",
  description: "Read-only list of an account's jobs",
};

export default function JobsPage() {
  return <JobsView />;
}
