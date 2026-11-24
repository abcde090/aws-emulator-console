"use client";

/**
 * Launch an instance: the console's single-page wizard (Name and tags, Application and OS
 * Images, Instance type, Key pair, Network settings, Configure storage, Advanced details and
 * the Summary panel). Every list comes from the emulator; Launch calls RunInstances.
 */

import Link from "next/link";
import { useMemo, useState, type ReactNode } from "react";
import { Modal } from "@/console/ui/Modal";
import { Button, buttonClass, Container, ErrorBanner, Flash, PageHeader } from "@/console/ui/primitives";
import { KeyPairForm } from "./KeyPairForm";
import { launchFromWizard } from "./launch-actions";
import type { WizardData, WizardImage } from "./launch-data";
import { VOLUME_TYPES } from "./launch-spec";

const inputClass = "w-full rounded-[4px] border border-[#879596] bg-white px-2.5 py-1.5 text-[13px] focus:border-primary focus:outline-none focus:ring-1 focus:ring-primary";

function Field({ label, help, children, htmlFor }: { label: string; help?: string; children: ReactNode; htmlFor?: string }) {
  return (
    <div className="space-y-1">
      <label htmlFor={htmlFor} className="block font-bold">
        {label}
      </label>
      {help && <p className="text-[13px] text-muted">{help}</p>}
      {children}
    </div>
  );
}

function ListError({ data, keys }: { data: WizardData; keys: string[] }) {
  const msgs = keys.map((k) => data.errors[k]).filter(Boolean);
  return msgs.length ? <ErrorBanner title="Could not load" message={msgs.join("\n")} /> : null;
}

type Tag = { Key: string; Value: string };

interface FirewallState {
  mode: "create" | "existing";
  name: string;
  description: string;
  allowSsh: boolean;
  sshSource: string;
  allowHttps: boolean;
  allowHttp: boolean;
  existing: string[];
}

export function LaunchWizard({ data }: { data: WizardData }) {
  const defaultVpc = data.vpcs.find((v) => v.isDefault)?.id ?? data.vpcs[0]?.id ?? "";
  const families = useMemo(() => [...new Set(data.images.filter((i) => i.source === "quickstart").map((i) => i.family))], [data.images]);
  const [name, setName] = useState("");
  const [tags, setTags] = useState<Tag[]>([]);
  const [imageSource, setImageSource] = useState<"quickstart" | "mine">("quickstart");
  const [family, setFamily] = useState(families.includes("Amazon Linux") ? "Amazon Linux" : families[0] ?? "");
  const [arch, setArch] = useState("x86_64");
  const [imageId, setImageId] = useState("");
  const [imageQuery, setImageQuery] = useState("");
  const [instanceType, setInstanceType] = useState("t3.micro");
  const [typeQuery, setTypeQuery] = useState("");
  const [keyPairs, setKeyPairs] = useState(data.keyPairs);
  const [keyName, setKeyName] = useState("");
  const [keyModal, setKeyModal] = useState(false);
  const [vpcId, setVpcId] = useState(defaultVpc);
  const [subnetId, setSubnetId] = useState("");
  const [publicIp, setPublicIp] = useState<"enable" | "disable">("enable");
  const [fw, setFw] = useState<FirewallState>({
    mode: "create",
    name: data.suggestedGroupName,
    description: `${data.suggestedGroupName} created ${new Date().toISOString().replace("T", " ").slice(0, 19)}`,
    allowSsh: true,
    sshSource: "0.0.0.0/0",
    allowHttps: false,
    allowHttp: false,
    existing: [],
  });
  const [volumeSize, setVolumeSize] = useState<number | null>(null);
  const [volumeType, setVolumeType] = useState<string>("");
  const [advanced, setAdvanced] = useState(false);
  const [profile, setProfile] = useState("");
  const [protection, setProtection] = useState(false);
  const [monitoring, setMonitoring] = useState(false);
  const [userData, setUserData] = useState("");
  const [count, setCount] = useState(1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [launched, setLaunched] = useState<{ ids: string[]; message: string } | null>(null);

  const q = imageQuery.trim().toLowerCase();
  const candidates = data.images.filter(
    (i) => i.source === imageSource && (imageSource === "mine" || i.family === family) && (q === "" || `${i.name} ${i.id} ${i.description}`.toLowerCase().includes(q))
  );
  const archs = [...new Set(candidates.map((i) => i.architecture))].filter(Boolean).sort();
  const shown = candidates.filter((i) => archs.length <= 1 || i.architecture === arch);
  const image: WizardImage | undefined = data.images.find((i) => i.id === imageId) ?? shown[0];
  const types = data.instanceTypes.filter((t) => (!image || t.architectures.length === 0 || t.architectures.includes(image.architecture)) && t.type.includes(typeQuery.trim().toLowerCase()));
  const typeInfo = data.instanceTypes.find((t) => t.type === instanceType);
  const subnets = data.subnets.filter((s) => s.vpcId === vpcId);
  const groupsInVpc = data.securityGroups.filter((g) => g.vpcId === vpcId);
  const effectiveSize = volumeSize ?? image?.rootSize ?? null;
  const effectiveType = volumeType || image?.rootType || "gp3";
  const archMismatch = image && typeInfo && typeInfo.architectures.length > 0 && !typeInfo.architectures.includes(image.architecture);

  function chooseSubnet(id: string) {
    setSubnetId(id);
    const s = data.subnets.find((x) => x.id === id);
    setPublicIp(s ? (s.mapPublicIp ? "enable" : "disable") : "enable");
  }

  async function launch() {
    if (!image) return setError("Choose an Amazon Machine Image (AMI).");
    setBusy(true);
    setError(null);
    const r = await launchFromWizard({
      name,
      tags,
      imageId: image.id,
      instanceType,
      keyName: keyName || null,
      vpcId: vpcId || null,
      subnetId: subnetId || null,
      autoAssignPublicIp: publicIp,
      securityGroupIds: fw.mode === "existing" ? fw.existing : [],
      newSecurityGroup: fw.mode === "create" ? { name: fw.name, description: fw.description, allowSsh: fw.allowSsh, sshSource: fw.sshSource, allowHttps: fw.allowHttps, allowHttp: fw.allowHttp } : null,
      volumeSize: volumeSize,
      volumeType: volumeType || null,
      userData,
      count,
      iamInstanceProfile: profile || null,
      terminationProtection: protection,
      detailedMonitoring: monitoring,
    });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setLaunched({ ids: r.data.instanceIds, message: r.data.message });
    window.scrollTo({ top: 0 });
  }

  if (launched) {
    return (
      <div className="max-w-4xl space-y-4" data-testid="launch-success">
        <PageHeader title="Launch an instance" />
        <Flash kind="success" message={`Success. ${launched.message}`} />
        <Container title="Next steps">
          <ul className="list-disc space-y-1 pl-5">
            {launched.ids.map((id) => (
              <li key={id}>
                <Link href={`/ec2/instances/${id}`}>{id}</Link>
              </li>
            ))}
          </ul>
          <div className="mt-4 flex gap-2">
            <Link href="/ec2/instances" className={buttonClass("primary")}>
              View all instances
            </Link>
          </div>
        </Container>
      </div>
    );
  }

  return (
    <div className="space-y-4" data-testid="launch-wizard">
      <PageHeader title="Launch an instance" description="Amazon EC2 allows you to create virtual machines, or instances, that run on the AWS Cloud. Quickly get started by following the simple steps below." />
      <div className="grid gap-5 lg:grid-cols-[1fr_320px]">
        <div className="min-w-0 space-y-5">
          <Container title="Name and tags">
            <Field label="Name" htmlFor="wiz-name">
              <input id="wiz-name" className={inputClass} placeholder="e.g. My Web Server" value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="mt-3 space-y-2">
              {tags.map((t, i) => (
                <div key={i} className="flex gap-2">
                  <input aria-label={`Tag key ${i + 1}`} className={inputClass} placeholder="Key" value={t.Key} onChange={(e) => setTags(tags.map((x, j) => (j === i ? { ...x, Key: e.target.value } : x)))} />
                  <input aria-label={`Tag value ${i + 1}`} className={inputClass} placeholder="Value" value={t.Value} onChange={(e) => setTags(tags.map((x, j) => (j === i ? { ...x, Value: e.target.value } : x)))} />
                  <Button variant="link" onClick={() => setTags(tags.filter((_, j) => j !== i))}>
                    Remove
                  </Button>
                </div>
              ))}
              <Button onClick={() => setTags([...tags, { Key: "", Value: "" }])}>Add additional tags</Button>
            </div>
          </Container>

          <Container title="Application and OS Images (Amazon Machine Image)" description="An AMI contains the software configuration (operating system, application server and applications) required to launch your instance.">
            <ListError data={data} keys={["images", "myImages"]} />
            <input type="search" aria-label="Search AMIs" className={`${inputClass} mb-3`} placeholder="Search our full catalog of AMIs by name or ID" value={imageQuery} onChange={(e) => setImageQuery(e.target.value)} />
            <div role="tablist" className="mb-3 flex gap-1 border-b border-line">
              {(["quickstart", "mine"] as const).map((s) => (
                <button key={s} type="button" role="tab" aria-selected={imageSource === s} onClick={() => { setImageSource(s); setImageId(""); }} className={`-mb-px border-b-2 px-3 py-1.5 font-bold ${imageSource === s ? "border-primary text-primary" : "border-transparent"}`}>
                  {s === "quickstart" ? "Quick Start" : "My AMIs"}
                </button>
              ))}
            </div>
            {imageSource === "quickstart" && (
              <div className="mb-3 flex flex-wrap gap-2" aria-label="Operating system">
                {families.map((f) => (
                  <button key={f} type="button" aria-pressed={family === f} onClick={() => { setFamily(f); setImageId(""); }} className={`rounded-[6px] border px-4 py-2 font-bold ${family === f ? "border-primary bg-[#f2f8fd] text-primary" : "border-line-soft"}`}>
                    {f}
                  </button>
                ))}
              </div>
            )}
            {shown.length === 0 ? (
              <p className="text-muted">{imageSource === "mine" ? "You don't own any AMIs. Register one on the AMIs page." : "No AMIs match."}</p>
            ) : (
              <div className="space-y-3">
                <Field label="Amazon Machine Image (AMI)" htmlFor="wiz-ami">
                  <select id="wiz-ami" className={inputClass} value={image?.id ?? ""} onChange={(e) => setImageId(e.target.value)}>
                    {shown.map((i) => (
                      <option key={i.id} value={i.id}>
                        {i.description || i.name} - {i.id}
                        {i.freeTier ? " (Free tier eligible)" : ""}
                      </option>
                    ))}
                  </select>
                </Field>
                {image && (
                  <dl className="grid grid-cols-1 gap-2 text-[13px] md:grid-cols-3" data-testid="ami-details">
                    <div><dt className="font-bold text-muted">AMI ID</dt><dd>{image.id}</dd></div>
                    <div><dt className="font-bold text-muted">AMI name</dt><dd className="break-all">{image.name}</dd></div>
                    <div><dt className="font-bold text-muted">Platform</dt><dd>{image.platform || "-"}</dd></div>
                  </dl>
                )}
                {archs.length > 1 && (
                  <div role="radiogroup" aria-label="Architecture" className="flex gap-4">
                    <span className="font-bold">Architecture</span>
                    {archs.map((a) => (
                      <label key={a} className="flex items-center gap-1">
                        <input type="radio" checked={arch === a} onChange={() => { setArch(a); setImageId(""); }} /> {a === "arm64" ? "64-bit (Arm)" : a === "x86_64" ? "64-bit (x86)" : a}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            )}
          </Container>

          <Container title="Instance type">
            <ListError data={data} keys={["instanceTypes"]} />
            <div className="grid gap-2 md:grid-cols-[200px_1fr]">
              <input type="search" aria-label="Filter instance types" className={inputClass} placeholder="Filter, e.g. t3" value={typeQuery} onChange={(e) => setTypeQuery(e.target.value)} />
              <select aria-label="Instance type" className={inputClass} value={instanceType} onChange={(e) => setInstanceType(e.target.value)}>
                {!types.some((t) => t.type === instanceType) && <option value={instanceType}>{instanceType}</option>}
                {types.map((t) => (
                  <option key={t.type} value={t.type}>
                    {t.type} - {t.vcpu ?? "?"} vCPU, {t.memoryGiB ?? "?"} GiB Memory{t.freeTier ? " (Free tier eligible)" : ""}
                  </option>
                ))}
              </select>
            </div>
            {typeInfo && <p className="mt-2 text-[13px] text-muted">Family: {typeInfo.type.split(".")[0]} · {typeInfo.vcpu ?? "?"} vCPU · {typeInfo.memoryGiB ?? "?"} GiB Memory · Architectures: {typeInfo.architectures.join(", ") || "-"}</p>}
            {archMismatch && <p className="mt-2 text-bad">{instanceType} does not support the {image?.architecture} architecture of the selected AMI.</p>}
          </Container>

          <Container title="Key pair (login)" description="You can use a key pair to securely connect to your instance. Ensure that you have access to the selected key pair before you launch the instance.">
            <ListError data={data} keys={["keyPairs"]} />
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-64 flex-1">
                <Field label="Key pair name - required" htmlFor="wiz-key">
                  <select id="wiz-key" className={inputClass} value={keyName} onChange={(e) => setKeyName(e.target.value)}>
                    <option value="">Proceed without a key pair (Not recommended)</option>
                    {keyPairs.map((k) => (
                      <option key={k.name} value={k.name}>
                        {k.label}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <Button onClick={() => setKeyModal(true)}>Create new key pair</Button>
            </div>
          </Container>

          <NetworkSection data={data} vpcId={vpcId} setVpcId={(v) => { setVpcId(v); setSubnetId(""); setFw((f) => ({ ...f, existing: [] })); }} subnets={subnets} subnetId={subnetId} setSubnetId={chooseSubnet} publicIp={publicIp} setPublicIp={setPublicIp} fw={fw} setFw={setFw} groupsInVpc={groupsInVpc} />

          <Container title="Configure storage">
            <div className="flex flex-wrap items-center gap-2">
              <span>1x</span>
              <input aria-label="Root volume size (GiB)" type="number" min={1} max={16384} className={`${inputClass} max-w-28`} value={effectiveSize ?? ""} onChange={(e) => setVolumeSize(e.target.value === "" ? null : Number(e.target.value))} />
              <span>GiB</span>
              <select aria-label="Root volume type" className={`${inputClass} max-w-40`} value={effectiveType} onChange={(e) => setVolumeType(e.target.value)}>
                {VOLUME_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
              <span>Root volume{image?.rootDevice ? ` (${image.rootDevice})` : ""}</span>
            </div>
            <p className="mt-2 text-[13px] text-muted">Defaults come from the AMI&apos;s root block device mapping. Change them to override it.</p>
          </Container>

          <Container title="Advanced details" actions={<Button variant="link" onClick={() => setAdvanced(!advanced)} aria-expanded={advanced}>{advanced ? "Hide" : "Show"}</Button>}>
            {advanced ? (
              <div className="space-y-4">
                <ListError data={data} keys={["instanceProfiles"]} />
                <Field label="IAM instance profile" htmlFor="wiz-profile">
                  <select id="wiz-profile" className={inputClass} value={profile} onChange={(e) => setProfile(e.target.value)}>
                    <option value="">Select</option>
                    {data.instanceProfiles.map((p) => (
                      <option key={p.name} value={p.name}>
                        {p.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <label className="flex items-center gap-2"><input type="checkbox" checked={protection} onChange={(e) => setProtection(e.target.checked)} /> Termination protection: Enable</label>
                <label className="flex items-center gap-2"><input type="checkbox" checked={monitoring} onChange={(e) => setMonitoring(e.target.checked)} /> Detailed CloudWatch monitoring: Enable</label>
                <Field label="User data - optional" help="Enter user data in the field. It is base64-encoded for you." htmlFor="wiz-userdata">
                  <textarea id="wiz-userdata" className={`${inputClass} min-h-32 font-mono text-[13px]`} value={userData} onChange={(e) => setUserData(e.target.value)} placeholder={"#!/bin/bash\nyum install -y httpd"} />
                </Field>
              </div>
            ) : (
              <p className="text-muted">IAM instance profile, termination protection, detailed monitoring and user data.</p>
            )}
          </Container>
        </div>

        <aside className="lg:sticky lg:top-4 lg:self-start">
          <Container title="Summary">
            <div className="space-y-3">
              <Field label="Number of instances" htmlFor="wiz-count">
                <input id="wiz-count" type="number" min={1} max={20} className={`${inputClass} max-w-28`} value={count} onChange={(e) => setCount(Number(e.target.value) || 1)} />
              </Field>
              <dl className="space-y-2 text-[13px]">
                <div><dt className="font-bold">Software Image (AMI)</dt><dd className="break-all">{image ? `${image.description || image.name} (${image.id})` : "-"}</dd></div>
                <div><dt className="font-bold">Virtual server type (instance type)</dt><dd>{instanceType}</dd></div>
                <div><dt className="font-bold">Firewall (security group)</dt><dd>{fw.mode === "create" ? `New security group (${fw.name})` : fw.existing.join(", ") || "-"}</dd></div>
                <div><dt className="font-bold">Storage (volumes)</dt><dd>1 volume(s) - {effectiveSize ?? "?"} GiB {effectiveType}</dd></div>
              </dl>
              {error && <ErrorBanner message={error} onDismiss={() => setError(null)} />}
              <div className="flex justify-end gap-2">
                <Link href="/ec2/instances" className={buttonClass("link")}>
                  Cancel
                </Link>
                <Button variant="primary" disabled={busy || !image} onClick={() => void launch()} data-testid="launch-submit">
                  {busy ? "Launching…" : "Launch instance"}
                </Button>
              </div>
            </div>
          </Container>
        </aside>
      </div>
      {keyModal && (
        <Modal title="Create key pair" onClose={() => setKeyModal(false)}>
          <KeyPairForm
            onCancel={() => setKeyModal(false)}
            onDone={(n) => {
              setKeyPairs((prev) => (prev.some((k) => k.name === n) ? prev : [...prev, { name: n, label: n }]));
              setKeyName(n);
            }}
          />
        </Modal>
      )}
    </div>
  );
}

interface NetworkProps {
  data: WizardData;
  vpcId: string;
  setVpcId: (v: string) => void;
  subnets: WizardData["subnets"];
  subnetId: string;
  setSubnetId: (v: string) => void;
  publicIp: "enable" | "disable";
  setPublicIp: (v: "enable" | "disable") => void;
  fw: FirewallState;
  setFw: (f: FirewallState | ((prev: FirewallState) => FirewallState)) => void;
  groupsInVpc: WizardData["securityGroups"];
}

function NetworkSection({ data, vpcId, setVpcId, subnets, subnetId, setSubnetId, publicIp, setPublicIp, fw, setFw, groupsInVpc }: NetworkProps) {
  return (
    <Container title="Network settings">
      <ListError data={data} keys={["vpcs", "subnets", "securityGroups"]} />
      <div className="space-y-4">
        <Field label="VPC - required" htmlFor="wiz-vpc">
          <select id="wiz-vpc" className={inputClass} value={vpcId} onChange={(e) => setVpcId(e.target.value)}>
            {data.vpcs.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Subnet" htmlFor="wiz-subnet">
          <select id="wiz-subnet" className={inputClass} value={subnetId} onChange={(e) => setSubnetId(e.target.value)}>
            <option value="">No preference (Default subnet in any availability zone)</option>
            {subnets.map((s) => (
              <option key={s.id} value={s.id}>
                {s.label} - VPC: {s.vpcId} Availability Zone: {s.az} IP range: {s.cidr}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Auto-assign public IP" htmlFor="wiz-publicip">
          <select id="wiz-publicip" className={`${inputClass} max-w-xs`} value={publicIp} onChange={(e) => setPublicIp(e.target.value === "disable" ? "disable" : "enable")}>
            <option value="enable">Enable</option>
            <option value="disable">Disable</option>
          </select>
        </Field>
        <fieldset className="space-y-2">
          <legend className="font-bold">Firewall (security groups)</legend>
          <p className="text-[13px] text-muted">A security group is a set of firewall rules that control the traffic for your instance.</p>
          <div className="flex flex-wrap gap-4">
            <label className="flex items-center gap-2"><input type="radio" checked={fw.mode === "create"} onChange={() => setFw((f) => ({ ...f, mode: "create" }))} /> Create security group</label>
            <label className="flex items-center gap-2"><input type="radio" checked={fw.mode === "existing"} onChange={() => setFw((f) => ({ ...f, mode: "existing" }))} /> Select existing security group</label>
          </div>
          {fw.mode === "create" ? (
            <div className="space-y-3 rounded-[6px] border border-line bg-white p-3">
              <p className="text-[13px] text-muted">We&apos;ll create a new security group called <strong>{fw.name}</strong> in {vpcId || "the default VPC"} with the following rules:</p>
              <Field label="Security group name" htmlFor="wiz-sg-name">
                <input id="wiz-sg-name" className={inputClass} value={fw.name} onChange={(e) => setFw((f) => ({ ...f, name: e.target.value }))} />
              </Field>
              <Field label="Description" htmlFor="wiz-sg-desc">
                <input id="wiz-sg-desc" className={inputClass} value={fw.description} onChange={(e) => setFw((f) => ({ ...f, description: e.target.value }))} />
              </Field>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2"><input type="checkbox" checked={fw.allowSsh} onChange={(e) => setFw((f) => ({ ...f, allowSsh: e.target.checked }))} /> Allow SSH traffic from</label>
                <select aria-label="SSH source" className={`${inputClass} max-w-48`} value={fw.sshSource === "0.0.0.0/0" ? "anywhere" : "custom"} onChange={(e) => setFw((f) => ({ ...f, sshSource: e.target.value === "anywhere" ? "0.0.0.0/0" : "" }))}>
                  <option value="anywhere">Anywhere 0.0.0.0/0</option>
                  <option value="custom">Custom</option>
                </select>
                {fw.sshSource !== "0.0.0.0/0" && <input aria-label="SSH source CIDR" className={`${inputClass} max-w-48`} placeholder="203.0.113.0/24" value={fw.sshSource} onChange={(e) => setFw((f) => ({ ...f, sshSource: e.target.value }))} />}
              </div>
              <label className="flex items-center gap-2"><input type="checkbox" checked={fw.allowHttps} onChange={(e) => setFw((f) => ({ ...f, allowHttps: e.target.checked }))} /> Allow HTTPS traffic from the internet</label>
              <label className="flex items-center gap-2"><input type="checkbox" checked={fw.allowHttp} onChange={(e) => setFw((f) => ({ ...f, allowHttp: e.target.checked }))} /> Allow HTTP traffic from the internet</label>
              {fw.allowSsh && fw.sshSource === "0.0.0.0/0" && <p className="text-[13px] text-warn">Rules with source of 0.0.0.0/0 allow all IP addresses to access your instance. We recommend setting security group rules to allow access from known IP addresses only.</p>}
            </div>
          ) : (
            <div className="space-y-1 rounded-[6px] border border-line bg-white p-3" aria-label="Common security groups">
              {groupsInVpc.length === 0 && <p className="text-muted">No security groups in {vpcId}.</p>}
              {groupsInVpc.map((g) => (
                <label key={g.id} className="flex items-start gap-2">
                  <input type="checkbox" className="mt-1" checked={fw.existing.includes(g.id)} onChange={(e) => setFw((f) => ({ ...f, existing: e.target.checked ? [...f.existing, g.id] : f.existing.filter((x) => x !== g.id) }))} />
                  <span>
                    {g.name} <span className="text-muted">{g.id}</span>
                    <span className="block text-[13px] text-muted">{g.description}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
        </fieldset>
      </div>
    </Container>
  );
}
