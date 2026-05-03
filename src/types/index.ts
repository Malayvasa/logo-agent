export interface LinearIssuePayload {
  id: string;
  title: string;
  description: string;
  url: string;
  identifier: string;
  state: { name: string };
  team: { id: string; name: string };
  project?: { id: string; name: string };
  labels?: { id: string; name: string }[] | { nodes: { id: string; name: string }[] };
}

export interface LogoRequest {
  issueId: string;
  issueIdentifier: string;
  slug: string;
  websiteUrl: string;
  imageUrl?: string;
  // Hint that imageUrl points to an SVG even when the URL itself has no
  // .svg extension (e.g. Linear file-drop attachments at uploads.linear.app
  // store SVGs without extensions in the URL — only the markdown alt text
  // reveals the file type). When true, skip the vectorizer.
  imageUrlIsSvg?: boolean;
  // Raw SVG markup pasted into a Linear comment. Takes precedence over
  // imageUrl and skips favicon discovery + vectorization entirely.
  svgContent?: string;
}
