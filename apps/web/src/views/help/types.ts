export type HelpStep = {
  id: string;
  title: string;
  image: string;
  imageAlt: string;
  body: string[];
  caution?: string;
};

export type HelpSection = {
  id: string;
  title: string;
  intro?: string;
  steps: HelpStep[];
};

export type HelpManual = {
  role: "super_admin" | "site_manager" | "inspector";
  title: string;
  subtitle: string;
  sections: HelpSection[];
};
