'use client';
import EmailToFile from '@/app/shared/email/EmailToFile';
import { ENGINE_CSS } from '@/app/shared/engine/ui';

export default function EmailPage() {
  return (
    <div className="eg" style={{ maxWidth: 1100 }}>
      <style>{ENGINE_CSS}</style>
      <EmailToFile />
    </div>
  );
}
