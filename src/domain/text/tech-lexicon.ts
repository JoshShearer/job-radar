/**
 * Technology terms. Used two ways:
 *  - the verifier treats any of these in generated text as a CLAIM that must
 *    be supported by the cited evidence;
 *  - requirement matching lists the ones a posting names that the candidate
 *    does not claim, as "do not claim" material.
 *
 * Not exhaustive and not meant to be: the verifier also flags technology-shaped
 * tokens (CamelCase, dotted names, acronyms) and capitalized names that do not
 * appear in the evidence, so a term missing here is still caught.
 */
export const TECH_TERMS: readonly string[] = [
  // languages
  "javascript", "typescript", "python", "java", "kotlin", "scala", "swift", "objective-c", "go", "golang", "rust",
  "ruby", "php", "perl", "c", "c++", "c#", "f#", "elixir", "erlang", "clojure", "haskell", "ocaml", "r", "julia",
  "dart", "lua", "solidity", "bash", "shell", "sql", "graphql", "html", "css", "sass", "less", "webassembly", "wasm",
  // frontend
  "react", "react native", "next.js", "nextjs", "vue", "vue.js", "nuxt", "angular", "angularjs", "svelte", "sveltekit",
  "solid", "solidjs", "ember", "backbone", "jquery", "redux", "mobx", "zustand", "tailwind", "tailwindcss", "bootstrap",
  "material ui", "storybook", "webpack", "vite", "rollup", "esbuild", "babel", "three.js", "threejs", "webgl", "webgpu",
  "d3", "d3.js", "astro", "remix", "gatsby", "qwik", "htmx", "electron", "expo", "flutter",
  // backend & runtimes
  "node", "node.js", "nodejs", "deno", "bun", "express", "fastify", "nestjs", "koa", "hapi", "django", "flask",
  "fastapi", "rails", "ruby on rails", "laravel", "symfony", "spring", "spring boot", ".net", "asp.net", "phoenix",
  "grpc", "rest", "trpc", "websockets", "socket.io", "mqtt", "node-red", "payload", "payload cms", "strapi",
  "contentful", "sanity", "wordpress", "drupal", "shopify", "magento", "stripe",
  // data
  "postgresql", "postgres", "mysql", "mariadb", "sqlite", "mongodb", "dynamodb", "cassandra", "redis", "memcached",
  "elasticsearch", "opensearch", "solr", "clickhouse", "snowflake", "bigquery", "redshift", "databricks", "spark",
  "hadoop", "kafka", "kinesis", "rabbitmq", "sqs", "pulsar", "flink", "airflow", "dagster", "dbt", "pandas", "numpy",
  "neo4j", "supabase", "firebase", "firestore", "prisma", "sequelize", "typeorm", "drizzle", "pinecone", "weaviate",
  "pgvector", "vector database",
  // infra & cloud
  "aws", "amazon web services", "lambda", "aws lambda", "ec2", "s3", "cloudfront", "ecs", "eks", "fargate", "gcp",
  "google cloud", "azure", "vercel", "netlify", "heroku", "cloudflare", "fly.io", "docker", "kubernetes", "k8s", "helm",
  "terraform", "pulumi", "ansible", "chef", "puppet", "nginx", "linux", "ci/cd", "github actions", "gitlab ci",
  "jenkins", "circleci", "argo", "prometheus", "grafana", "datadog", "sentry", "new relic", "opentelemetry", "istio",
  "serverless", "microservices", "micro frontends",
  // ml & ai
  "tensorflow", "pytorch", "keras", "scikit-learn", "xgboost", "hugging face", "transformers", "langchain",
  "llamaindex", "openai", "anthropic", "claude", "gpt", "llm", "llms", "rag", "mcp", "kubeflow", "mlflow", "sagemaker",
  "vertex ai", "computer vision", "nlp", "reinforcement learning",
  // product & growth tooling
  "google analytics", "ga4", "google search console", "search console", "google tag manager", "segment", "amplitude",
  "mixpanel", "hubspot", "salesforce", "marketo", "optimizely", "launchdarkly", "algolia", "core web vitals", "crux",
  "pagespeed", "json-ld", "schema.org", "hreflang",
  // mobile / embedded / other
  "ios", "android", "swiftui", "jetpack compose", "arduino", "raspberry pi", "embedded", "fpga", "plc", "scada",
  "blockchain", "ethereum", "web3", "unity", "unreal", "figma",
];

/** Acronyms that are ordinary vocabulary, not technology claims. */
export const GENERIC_ACRONYMS: ReadonlySet<string> = new Set([
  "API", "APIS", "UI", "UX", "URL", "URLS", "US", "USA", "UK", "EU", "CEO", "CTO", "CFO", "COO", "VP", "HR", "B2B",
  "B2C", "SAAS", "OK", "FAQ", "PR", "Q1", "Q2", "Q3", "Q4", "KPI", "KPIS", "ROI", "MVP", "PM", "IT", "TV",
]);

/**
 * Terms that are also everyday English ("the rest of", "go live", "a solid
 * plan"). They count as technology only when written capitalized mid-sentence
 * or in all caps, which is how a technology name is written.
 */
export const AMBIGUOUS_TECH: ReadonlySet<string> = new Set([
  "go", "c", "r", "rest", "solid", "express", "spring", "payload", "segment", "remix", "sanity", "chef", "puppet",
  "argo", "phoenix", "lambda", "unity", "embedded", "swift", "ember", "backbone", "rails", "helm", "spark", "flask",
  "hapi", "koa", "bun", "deno", "dart", "lua", "julia", "less", "shell", "bash", "expo", "astro", "solr", "node",
  "stripe", "claude", "transformers", "contentful", "drizzle", "flutter", "rest", "airflow", "pulsar", "flink",
]);
