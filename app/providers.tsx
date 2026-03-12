"use client";

import type { ReactNode } from "react";
import { CssBaseline, ThemeProvider, createTheme } from "@mui/material";

const theme = createTheme({
  palette: {
    mode: "dark",
    primary: {
      main: "#22d3ee",
      light: "#67e8f9",
      dark: "#0891b2",
    },
    secondary: {
      main: "#f97316",
    },
    success: {
      main: "#10b981",
    },
    warning: {
      main: "#f59e0b",
    },
    error: {
      main: "#f43f5e",
    },
    background: {
      default: "#0b0f17",
      paper: "#111827",
    },
  },
  shape: {
    borderRadius: 18,
  },
  typography: {
    fontFamily: 'var(--font-geist-sans), "Segoe UI", sans-serif',
    h1: {
      fontWeight: 650,
      letterSpacing: -0.5,
    },
    h2: {
      fontWeight: 640,
      letterSpacing: -0.4,
    },
    h3: {
      fontWeight: 620,
      letterSpacing: -0.35,
    },
    h4: {
      fontWeight: 600,
    },
    button: {
      textTransform: "none",
      fontWeight: 600,
    },
  },
  components: {
    MuiCssBaseline: {
      styleOverrides: {
        "*, *::before, *::after": {
          boxSizing: "border-box",
        },
        html: {
          height: "100%",
        },
        body: {
          margin: 0,
          minHeight: "100%",
          backgroundColor: "#0b0f17",
          color: "#e5e7eb",
        },
      },
    },
    MuiPaper: {
      styleOverrides: {
        root: {
          backgroundImage: "none",
        },
      },
    },
    MuiButton: {
      styleOverrides: {
        root: {
          borderRadius: 12,
        },
      },
    },
    MuiChip: {
      styleOverrides: {
        root: {
          borderRadius: 999,
        },
      },
    },
  },
});

export default function Providers({ children }: { children: ReactNode }) {
  return (
    <ThemeProvider theme={theme}>
      <CssBaseline />
      {children}
    </ThemeProvider>
  );
}
