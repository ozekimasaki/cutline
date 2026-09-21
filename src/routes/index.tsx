import { createFileRoute } from "@tanstack/react-router";
import { Editor } from "@/components/editor";

export const Route = createFileRoute("/")({
  component: Home,
});

function Home() {
  return <Editor />;
}
