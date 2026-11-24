/** Hand-built Create key pair page: the private key is handed to the browser once, as a download. */

import { notFound } from "next/navigation";
import { getResource, getService } from "@/console/registry";
import { ServiceFrame } from "@/console/ui/pages";
import { PageHeader } from "@/console/ui/primitives";
import { KeyPairCreate } from "@/services/ec2/KeyPairForm";

export default function CreateKeyPairPage() {
  const service = getService("ec2");
  const resource = getResource("ec2", "key-pairs");
  if (!service || !resource) notFound();
  return (
    <ServiceFrame service={service} activeResource={resource.id} crumbs={[{ label: service.name, href: "/ec2" }, { label: resource.name, href: "/ec2/key-pairs" }, { label: "Create key pair" }]}>
      <PageHeader title="Create key pair" description="A key pair, consisting of a private key and a public key, is a set of security credentials that you use to prove your identity when connecting to an instance." />
      <KeyPairCreate />
    </ServiceFrame>
  );
}
