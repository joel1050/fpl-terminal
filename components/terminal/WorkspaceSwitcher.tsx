"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const WORKSPACES = [
  { href: "/", label: "Planner" },
  { href: "/leagues", label: "Leagues" },
];

export default function WorkspaceSwitcher() {
  const pathname = usePathname();
  return (
    <nav className="workspace-switcher" aria-label="Workspace">
      {WORKSPACES.map((workspace) => (
        <Link
          key={workspace.href}
          href={workspace.href}
          className={pathname === workspace.href ? "active" : ""}
        >
          {workspace.label}
        </Link>
      ))}
    </nav>
  );
}
