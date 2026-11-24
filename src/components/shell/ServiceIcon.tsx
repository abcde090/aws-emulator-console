/**
 * Category-colored AWS-style SVG icons for services in menus, search, Console Home, and sidebars.
 * Uses pure flat/subtle tones so there are no duplicate SVG gradient IDs across multiple instances.
 */

interface ServiceIconProps {
  serviceId: string;
  category?: string;
  size?: number;
  className?: string;
}

function paletteFor(serviceId: string, category = ""): { bg: string; accent: string } {
  const c = category.toLowerCase();
  if (
    ["ec2", "lambda", "ecs", "eks", "elasticbeanstalk", "computeoptimizer"].includes(serviceId) ||
    c.includes("compute") ||
    c.includes("container")
  ) {
    return { bg: "#d86613", accent: "#ff9900" };
  }
  if (["s3", "efs", "glacier", "backup"].includes(serviceId) || c.includes("storage")) {
    return { bg: "#2e7d32", accent: "#6cae3e" };
  }
  if (["dynamodb", "rds", "elasticache", "redshift", "dms"].includes(serviceId) || c.includes("database")) {
    return { bg: "#3b48cc", accent: "#527fff" };
  }
  if (["vpc", "route53", "cloudfront", "apigateway"].includes(serviceId) || c.includes("network")) {
    return { bg: "#693cc5", accent: "#8c4fff" };
  }
  if (
    ["iam", "identitycenter", "kms", "secretsmanager", "acm", "cognito", "ram", "waf", "guardduty", "securityhub"].includes(serviceId) ||
    c.includes("security")
  ) {
    return { bg: "#c7131f", accent: "#e53935" };
  }
  if (["sqs", "sns", "eventbridge", "stepfunctions"].includes(serviceId) || c.includes("integration")) {
    return { bg: "#cc2264", accent: "#ff4f8b" };
  }
  if (
    ["cloudwatch", "cloudtrail", "cloudformation", "config", "ssm", "organizations", "servicequotas", "fis", "resiliencehub", "wellarchitected"].includes(serviceId) ||
    c.includes("management") ||
    c.includes("governance")
  ) {
    return { bg: "#b0084d", accent: "#e7157b" };
  }
  if (["athena", "glue", "kinesis"].includes(serviceId) || c.includes("analytics")) {
    return { bg: "#5b2ea6", accent: "#8c4fff" };
  }
  if (["codebuild", "codecommit", "codepipeline", "xray"].includes(serviceId) || c.includes("developer")) {
    return { bg: "#2e4dc7", accent: "#4c72ff" };
  }
  if (serviceId === "cost" || c.includes("cost") || c.includes("billing")) {
    return { bg: "#1b7a3d", accent: "#43a047" };
  }
  return { bg: "#232f3e", accent: "#414d5c" };
}

function glyphFor(serviceId: string) {
  switch (serviceId) {
    case "s3":
      return (
        <>
          <ellipse cx="20" cy="12.5" rx="8" ry="2.6" stroke="white" strokeWidth="1.6" fill="none" />
          <path d="M12 12.5v15c0 1.4 3.6 2.6 8 2.6s8-1.2 8-2.6v-15" stroke="white" strokeWidth="1.6" fill="none" />
          <path d="M12 19.5c0 1.4 3.6 2.6 8 2.6s8-1.2 8-2.6" stroke="white" strokeWidth="1.4" fill="none" />
        </>
      );
    case "ec2":
      return (
        <>
          <rect x="13" y="13" width="14" height="14" rx="1.5" stroke="white" strokeWidth="1.6" fill="none" />
          <rect x="17" y="17" width="6" height="6" rx="0.8" fill="white" />
          <path d="M17 9v4M23 9v4M17 27v4M23 27v4M9 17h4M9 23h4M27 17h4M27 23h4" stroke="white" strokeWidth="1.4" strokeLinecap="round" />
        </>
      );
    case "lambda":
      return (
        <path d="M14 29l6-12m0 0l-3.5-6H14m6 6l6 12h3" stroke="white" strokeWidth="2.1" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      );
    case "sqs":
      return (
        <>
          <rect x="10" y="13" width="4.5" height="14" rx="1" stroke="white" strokeWidth="1.5" fill="none" />
          <rect x="17.75" y="13" width="4.5" height="14" rx="1" stroke="white" strokeWidth="1.5" fill="none" />
          <rect x="25.5" y="13" width="4.5" height="14" rx="1" stroke="white" strokeWidth="1.5" fill="none" />
        </>
      );
    case "sns":
      return (
        <>
          <circle cx="13" cy="20" r="3" stroke="white" strokeWidth="1.6" fill="none" />
          <circle cx="27" cy="12.5" r="2.5" stroke="white" strokeWidth="1.5" fill="none" />
          <circle cx="27" cy="20" r="2.5" stroke="white" strokeWidth="1.5" fill="none" />
          <circle cx="27" cy="27.5" r="2.5" stroke="white" strokeWidth="1.5" fill="none" />
          <path d="M16 18.5l8.5-5M16 20h8.5M16 21.5l8.5 5" stroke="white" strokeWidth="1.4" />
        </>
      );
    case "dynamodb":
      return (
        <>
          <ellipse cx="20" cy="12" rx="7.5" ry="2.5" stroke="white" strokeWidth="1.5" fill="none" />
          <path d="M12.5 12v16c0 1.4 3.4 2.5 7.5 2.5s7.5-1.1 7.5-2.5V12" stroke="white" strokeWidth="1.5" fill="none" />
          <path d="M21.5 16l-3.5 5h3l-2.5 5" stroke="white" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    case "rds":
    case "redshift":
    case "elasticache":
    case "dms":
      return (
        <>
          <ellipse cx="20" cy="12" rx="8" ry="2.6" stroke="white" strokeWidth="1.6" fill="none" />
          <path d="M12 12v16c0 1.4 3.6 2.6 8 2.6s8-1.2 8-2.6V12" stroke="white" strokeWidth="1.6" fill="none" />
          <path d="M12 17.5c0 1.4 3.6 2.6 8 2.6s8-1.2 8-2.6M12 23c0 1.4 3.6 2.6 8 2.6s8-1.2 8-2.6" stroke="white" strokeWidth="1.4" fill="none" />
        </>
      );
    case "iam":
    case "identitycenter":
    case "cognito":
      return (
        <>
          <circle cx="20" cy="15" r="4" stroke="white" strokeWidth="1.6" fill="none" />
          <path d="M12.5 29c0-4.2 3.4-7 7.5-7s7.5 2.8 7.5 7" stroke="white" strokeWidth="1.6" fill="none" strokeLinecap="round" />
        </>
      );
    case "kms":
    case "secretsmanager":
    case "acm":
      return (
        <>
          <circle cx="16.5" cy="18.5" r="4.5" stroke="white" strokeWidth="1.6" fill="none" />
          <path d="M20.5 20.5L29 29M25 25l2.5-2.5M27.5 27.5L30 25" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
        </>
      );
    case "waf":
    case "guardduty":
    case "securityhub":
    case "ram":
      return (
        <path d="M20 10l9 3.5v6.5c0 5.5-3.8 9.2-9 11-5.2-1.8-9-5.5-9-11v-6.5L20 10z" stroke="white" strokeWidth="1.6" fill="none" strokeLinejoin="round" />
      );
    case "vpc":
    case "cloudfront":
    case "route53":
    case "apigateway":
      return (
        <>
          <circle cx="20" cy="20" r="8.5" stroke="white" strokeWidth="1.5" fill="none" />
          <ellipse cx="20" cy="20" rx="4" ry="8.5" stroke="white" strokeWidth="1.3" fill="none" />
          <path d="M11.5 20h17" stroke="white" strokeWidth="1.3" />
        </>
      );
    case "ecs":
    case "eks":
      return (
        <>
          <rect x="11" y="12" width="18" height="16" rx="2" stroke="white" strokeWidth="1.6" fill="none" />
          <path d="M15.5 16.5v7M20 16.5v7M24.5 16.5v7" stroke="white" strokeWidth="1.6" strokeLinecap="round" />
        </>
      );
    case "cloudwatch":
    case "xray":
    case "cost":
      return (
        <>
          <path d="M11 27h18M13 24v-5M18 24v-9M23 24v-6M28 24v-11" stroke="white" strokeWidth="1.8" strokeLinecap="round" />
        </>
      );
    case "cloudformation":
    case "codebuild":
    case "codecommit":
    case "codepipeline":
      return (
        <>
          <rect x="11" y="11" width="7" height="7" rx="1" stroke="white" strokeWidth="1.5" fill="none" />
          <rect x="22" y="11" width="7" height="7" rx="1" stroke="white" strokeWidth="1.5" fill="none" />
          <rect x="11" y="22" width="7" height="7" rx="1" stroke="white" strokeWidth="1.5" fill="none" />
          <rect x="22" y="22" width="7" height="7" rx="1" stroke="white" strokeWidth="1.5" fill="none" />
        </>
      );
    case "eventbridge":
    case "stepfunctions":
      return (
        <>
          <circle cx="13" cy="20" r="2.8" stroke="white" strokeWidth="1.5" fill="none" />
          <circle cx="27" cy="20" r="2.8" stroke="white" strokeWidth="1.5" fill="none" />
          <path d="M16 20h8M21.5 17l3 3-3 3" stroke="white" strokeWidth="1.6" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </>
      );
    default:
      return (
        <>
          <rect x="12" y="12" width="16" height="16" rx="2.5" stroke="white" strokeWidth="1.6" fill="none" />
          <circle cx="20" cy="20" r="3" fill="white" />
        </>
      );
  }
}

export function ServiceIcon({ serviceId, category, size = 20, className = "" }: ServiceIconProps) {
  const { bg } = paletteFor(serviceId, category);
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 40 40"
      className={`shrink-0 ${className}`}
      aria-hidden="true"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width="40" height="40" rx="4" fill={bg} />
      {glyphFor(serviceId)}
    </svg>
  );
}
