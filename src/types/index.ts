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
}
