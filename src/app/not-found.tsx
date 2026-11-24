import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-3xl px-8 py-10">
      <h1 className="text-2xl font-bold">Page not found</h1>
      <p className="mt-2 text-muted">This console has no screen at this address.</p>
      <p className="mt-4">
        <Link href="/">Go to Console Home</Link>
      </p>
    </main>
  );
}
