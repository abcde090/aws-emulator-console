import type { Metadata } from "next";
import { Fragment, type ReactNode } from "react";
import "./globals.css";
import { serviceCatalog } from "@/console/registry";
import { getActiveIdentity, switchIdentity } from "@/lib/identity";
import { principalArn } from "@/lib/permissions";
import { selectedRegion } from "@/lib/selected-region";
import { TopBar } from "@/components/shell/TopBar";
import type { IdentityView } from "@/components/shell/IdentityMenu";

export const metadata: Metadata = {
  title: "AWS Emulator Console",
  description: "A local console for AWS Emulator. Not affiliated with or endorsed by Amazon Web Services.",
};

async function identityView(): Promise<IdentityView> {
  const id = await getActiveIdentity();
  const label = id.type === "admin" ? "emulator (admin)" : id.type === "invalid" ? "invalid identity" : `${id.type}: ${id.name}`;
  return { type: id.type, name: id.name, arn: principalArn(id), label, loadErrors: id.type === "admin" ? [] : id.loadErrors ?? [] };
}

export default async function RootLayout({ children }: { children: ReactNode }) {
  const [identity, region] = await Promise.all([identityView(), selectedRegion()]);
  return (
    <html lang="en">
      <body className="min-h-screen pb-[40vh]">
        <TopBar services={serviceCatalog()} identity={identity} switchIdentity={switchIdentity} region={region} />
        {/* Keyed by Region: a Region switch remounts the page, so no screen keeps the old Region's rows. */}
        <Fragment key={region}>{children}</Fragment>
      </body>
    </html>
  );
}
