export default function Home() {
  return (
    <main style={{ padding: "2rem", fontFamily: "monospace" }}>
      <h1>logo-agent</h1>
      <p>
        Automated pipeline: Linear issue → favicon → vectorizer.ai → SVG →
        GitHub PR
      </p>
      <p>
        <strong>Webhook endpoint:</strong> <code>/api/webhook</code>
      </p>
    </main>
  );
}
