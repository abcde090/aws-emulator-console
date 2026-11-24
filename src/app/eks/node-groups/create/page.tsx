/** Create form with the cluster preset from ?cluster= (see PrefilledCreatePage). */

import { PrefilledCreatePage } from "@/services/eks/PrefilledCreate";

export default function Page({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return <PrefilledCreatePage resourceId="node-groups" searchParams={searchParams} />;
}
