'use client';

import Link from 'next/link';
import { useSession, signOut } from 'next-auth/react';
import { useState } from 'react';
import { Shield, Menu, X, LayoutDashboard, PlusCircle, LogIn, UserPlus, LogOut } from 'lucide-react';

export default function Navbar() {
  const { data: session, status } = useSession();
  const [mobileOpen, setMobileOpen] = useState(false);

  const isAuthenticated = status === 'authenticated';

  return (
    <nav className="glass sticky top-0 z-40 border-b border-border-light">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link href="/" className="flex items-center gap-2.5 group">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-primary to-primary-light flex items-center justify-center shadow-md group-hover:shadow-lg transition-shadow">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <span className="text-lg font-bold text-secondary tracking-tight">
              Site<span className="text-primary">Check</span>
            </span>
          </Link>

          {/* Desktop Nav Links */}
          <div className="hidden md:flex items-center gap-1">
            {isAuthenticated && (
              <>
                <Link href="/dashboard" className="btn-ghost">
                  <LayoutDashboard className="w-4 h-4" />
                  Dashboard
                </Link>
                <Link href="/audit/new" className="btn-ghost">
                  <PlusCircle className="w-4 h-4" />
                  New Audit
                </Link>
              </>
            )}
          </div>

          {/* Desktop Right Side */}
          <div className="hidden md:flex items-center gap-3">
            {isAuthenticated ? (
              <>
                <span className="text-sm text-text-secondary font-medium">
                  {session?.user?.name || session?.user?.email}
                </span>
                <button
                  onClick={() => signOut({ callbackUrl: '/' })}
                  className="btn-ghost text-danger hover:!text-danger"
                >
                  <LogOut className="w-4 h-4" />
                  Sign Out
                </button>
              </>
            ) : (
              <>
                <Link href="/login" className="btn-ghost">
                  <LogIn className="w-4 h-4" />
                  Login
                </Link>
                <Link href="/signup" className="btn-primary text-sm px-4 py-2">
                  <UserPlus className="w-4 h-4" />
                  Sign Up
                </Link>
              </>
            )}
          </div>

          {/* Mobile Menu Button */}
          <button
            onClick={() => setMobileOpen(!mobileOpen)}
            className="md:hidden btn-ghost p-2"
            aria-label="Toggle menu"
          >
            {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
          </button>
        </div>
      </div>

      {/* Mobile Menu */}
      {mobileOpen && (
        <div className="md:hidden border-t border-border-light bg-white/95 backdrop-blur-sm animate-slide-down">
          <div className="px-4 py-4 space-y-1">
            {isAuthenticated ? (
              <>
                <div className="px-3 py-2 mb-3">
                  <p className="text-sm font-medium text-text-primary">{session?.user?.name}</p>
                  <p className="text-xs text-text-muted">{session?.user?.email}</p>
                </div>
                <Link
                  href="/dashboard"
                  className="btn-ghost w-full justify-start"
                  onClick={() => setMobileOpen(false)}
                >
                  <LayoutDashboard className="w-4 h-4" />
                  Dashboard
                </Link>
                <Link
                  href="/audit/new"
                  className="btn-ghost w-full justify-start"
                  onClick={() => setMobileOpen(false)}
                >
                  <PlusCircle className="w-4 h-4" />
                  New Audit
                </Link>
                <hr className="my-2 border-border-light" />
                <button
                  onClick={() => { signOut({ callbackUrl: '/' }); setMobileOpen(false); }}
                  className="btn-ghost w-full justify-start text-danger hover:!text-danger"
                >
                  <LogOut className="w-4 h-4" />
                  Sign Out
                </button>
              </>
            ) : (
              <>
                <Link
                  href="/login"
                  className="btn-ghost w-full justify-start"
                  onClick={() => setMobileOpen(false)}
                >
                  <LogIn className="w-4 h-4" />
                  Login
                </Link>
                <Link
                  href="/signup"
                  className="btn-primary w-full justify-center mt-2"
                  onClick={() => setMobileOpen(false)}
                >
                  <UserPlus className="w-4 h-4" />
                  Sign Up
                </Link>
              </>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
