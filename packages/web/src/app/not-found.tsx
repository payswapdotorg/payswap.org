import Link from "next/link";

export default function NotFound() {
  return (
    <div className="mx-auto max-w-6xl px-4 py-24 text-center sm:px-6">
      <p className="text-sm font-semibold uppercase tracking-wide text-emerald-700">
        404
      </p>
      <h1 className="mt-3 text-3xl font-bold tracking-tight text-stone-900">
        Page not found
      </h1>
      <p className="mx-auto mt-4 max-w-md text-stone-600">
        This route does not exist in the PaySwap web surface. Deep links into
        the Command Center live under /app — every valid section there
        resolves.
      </p>
      <Link
        href="/"
        className="mt-10 inline-flex min-h-[44px] items-center rounded-lg bg-emerald-700 px-5 py-2.5 text-sm font-semibold text-white hover:bg-emerald-800 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-emerald-800"
      >
        Back to home
      </Link>
    </div>
  );
}
