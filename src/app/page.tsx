import { redirect } from "next/navigation";

// Single-surface app: the root just sends you to Ember. The MCP deep links
// (/ember?session=...) hit the real page directly, so this is only for a
// bare visit to "/".
export default function Home() {
  redirect("/ember");
}
