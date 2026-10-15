// vite の環境変数（import.meta.env）の型＝data.ts が読む VITE_WORLD_DATA だけ
interface ImportMetaEnv { readonly VITE_WORLD_DATA?: string }
interface ImportMeta { readonly env: ImportMetaEnv }
