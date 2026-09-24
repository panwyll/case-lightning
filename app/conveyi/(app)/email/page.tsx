'use client';
import EmailToFile from '@/app/shared/email/EmailToFile';
import { ENGINE_CSS } from '@/app/shared/engine/ui';

export default function EmailPage() {
  return (
    <div className="eg" style={{ maxWidth: 900, margin: '0 auto', padding: '16px 16px 48px' }}>
      <style>{ENGINE_CSS}</style>
      <EmailToFile />
    </div>
  );
}
