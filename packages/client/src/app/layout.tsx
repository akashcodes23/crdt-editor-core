import type { Metadata } from 'next'
import './globals.css'

export const metadata: Metadata = {
  title: 'CRDT Collaborative Editor',
  description:
    'Real-time collaborative code editor built with Yjs CRDTs, Monaco Editor, and y-websocket — with offline-first sync and vector clock visualization.',
  keywords: ['CRDT', 'Yjs', 'collaborative editor', 'Monaco', 'real-time'],
}

export default function RootLayout({
  children,
}: {
  children: React.ReactNode
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
