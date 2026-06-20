import { redirect } from "next/navigation";

// Single-surface app: the root just sends you to Cloud Code. The MCP deep links
// (/cloud-code?session=...) hit the real page directly, so this is only for a
// bare visit to "/".
export default function Home() {
  redirect("/cloud-code");
}
