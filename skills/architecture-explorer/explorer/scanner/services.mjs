// Well-known client packages and the outside service each one talks to. A package reference is a verified fact; that
// the app uses the service through it is a reasonable inference, so these links are marked inferred.

const SERVICES = [
  // Databases and stores
  { id: "postgresql", label: "PostgreSQL", kind: "database", nuget: [/^Npgsql/], npm: [/^pg$/, /^postgres$/, /^@neondatabase\//] },
  { id: "sqlserver", label: "SQL Server", kind: "database", nuget: [/^Microsoft\.Data\.SqlClient$/, /^System\.Data\.SqlClient$/, /^Microsoft\.EntityFrameworkCore\.SqlServer$/], npm: [/^mssql$/, /^tedious$/] },
  { id: "mysql", label: "MySQL / MariaDB", kind: "database", nuget: [/^MySqlConnector$/, /^MySql\.Data$/, /^Pomelo\.EntityFrameworkCore\.MySql$/], npm: [/^mysql2?$/] },
  { id: "sqlite", label: "SQLite", kind: "database", nuget: [/^Microsoft\.Data\.Sqlite/, /^Microsoft\.EntityFrameworkCore\.Sqlite$/], npm: [/^(better-)?sqlite3$/] },
  { id: "mongodb", label: "MongoDB", kind: "database", nuget: [/^MongoDB\.Driver$/], npm: [/^mongodb$/, /^mongoose$/] },
  { id: "redis", label: "Redis", kind: "store", nuget: [/^StackExchange\.Redis$/], npm: [/^(io)?redis$/, /^@upstash\/redis$/] },
  { id: "supabase", label: "Supabase", kind: "service", nuget: [/^Supabase$/], npm: [/^@supabase\//] },
  { id: "firebase", label: "Firebase", kind: "service", nuget: [/^FirebaseAdmin$/, /^Google\.Cloud\.Firestore$/], npm: [/^firebase(-admin)?$/] },
  // Payments, messaging, email
  { id: "stripe", label: "Stripe", kind: "service", nuget: [/^Stripe\.net$/], npm: [/^stripe$/, /^@stripe\//] },
  { id: "paypal", label: "PayPal", kind: "service", nuget: [/^PayPal/], npm: [/^@paypal\//] },
  { id: "square", label: "Square", kind: "service", nuget: [/^Square$/], npm: [/^square$/] },
  { id: "twilio", label: "Twilio", kind: "service", nuget: [/^Twilio/], npm: [/^twilio$/] },
  { id: "sendgrid", label: "SendGrid", kind: "service", nuget: [/^SendGrid/], npm: [/^@sendgrid\//] },
  { id: "mailgun", label: "Mailgun", kind: "service", nuget: [/^Mailgun/], npm: [/^mailgun/] },
  { id: "postmark", label: "Postmark", kind: "service", nuget: [/^Postmark/], npm: [/^postmark$/] },
  { id: "resend", label: "Resend", kind: "service", nuget: [/^Resend$/], npm: [/^resend$/] },
  { id: "smtp", label: "Email over SMTP", kind: "service", nuget: [/^MailKit$/, /^FluentEmail\.Smtp$/], npm: [/^nodemailer$/] },
  // Clouds
  { id: "aws", label: "Amazon Web Services", kind: "service", nuget: [/^AWSSDK\./], npm: [/^@aws-sdk\//, /^aws-sdk$/] },
  { id: "azure", label: "Microsoft Azure", kind: "service", nuget: [/^Azure\./, /^Microsoft\.Azure\./], npm: [/^@azure\//] },
  { id: "gcp", label: "Google Cloud", kind: "service", nuget: [/^Google\.Cloud\./, /^Google\.Apis\./], npm: [/^@google-cloud\//, /^googleapis$/] },
  // Identity
  { id: "auth0", label: "Auth0", kind: "service", nuget: [/^Auth0\./], npm: [/^@auth0\//, /^auth0$/] },
  { id: "clerk", label: "Clerk", kind: "service", nuget: [/^Clerk/], npm: [/^@clerk\//] },
  { id: "entra", label: "Microsoft Entra ID", kind: "service", nuget: [/^Microsoft\.Identity\.Web/, /^Microsoft\.Identity\.Client$/], npm: [/^@azure\/msal-/] },
  // Monitoring and AI
  { id: "sentry", label: "Sentry", kind: "service", nuget: [/^Sentry/], npm: [/^@sentry\//] },
  { id: "appinsights", label: "Application Insights", kind: "service", nuget: [/^Microsoft\.ApplicationInsights/], npm: [/^applicationinsights$/, /^@microsoft\/applicationinsights/] },
  { id: "openai", label: "OpenAI", kind: "service", nuget: [/^OpenAI$/, /^Azure\.AI\.OpenAI$/], npm: [/^openai$/] },
  { id: "anthropic", label: "Anthropic (Claude)", kind: "service", nuget: [/^Anthropic/], npm: [/^@anthropic-ai\/sdk$/] },
  { id: "rabbitmq", label: "RabbitMQ", kind: "service", nuget: [/^RabbitMQ\.Client$/, /^MassTransit\.RabbitMQ$/], npm: [/^amqplib$/] },
];

/** packages: [{ name, eco: "nuget" | "npm", file, line }] -> [{ id, label, kind, package, eco, file, line }] */
export function knownServices(packages) {
  const out = [];
  for (const p of packages) {
    for (const s of SERVICES) {
      const patterns = s[p.eco] ?? [];
      if (patterns.some((re) => re.test(p.name))) {
        out.push({ id: s.id, label: s.label, kind: s.kind, package: p.name, eco: p.eco, file: p.file, line: p.line ?? 1 });
        break;
      }
    }
  }
  return out;
}
