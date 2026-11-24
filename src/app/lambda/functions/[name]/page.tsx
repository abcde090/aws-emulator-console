/**
 * Hand-built Lambda function screen: Code and Test tabs first, then the Configuration tabs
 * from the function definition. /lambda/functions/create is still the generic form.
 */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { decodeSegment, firstParam, GenericCreatePage, GenericDetailPage } from "@/console/ui/pages";
import { CodeTab } from "@/services/lambda/CodeTab";
import { TestTab } from "@/services/lambda/TestTab";

interface PageProps {
  params: Promise<{ name: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function FunctionPage({ params, searchParams }: PageProps) {
  const service = getService("lambda");
  const resource = getResource("lambda", "functions");
  if (!service || !resource) notFound();
  const name = decodeSegment((await params).name);
  if (name === "create") return <GenericCreatePage service={service} resource={resource} />;
  const created = firstParam((await searchParams).created);
  return (
    <GenericDetailPage
      service={service}
      resource={resource}
      id={name}
      flash={created ? `Successfully created the function ${created}. You can now change its code and configuration. To invoke your function with a test event, choose the Test tab.` : null}
      extraTabs={[
        { id: "code", label: "Code", content: <CodeTab name={name} /> },
        { id: "test", label: "Test", content: <TestTab name={name} /> },
      ]}
    />
  );
}
