import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Book A Demo — CONVEYi | Case Lightning',
  description: 'Fifteen minutes on your own kind of cases: what CONVEYi would take off your fee earners, and how we measure it. You pay nothing until your team handles double the cases.',
};

export default function DemoLayout({ children }: { children: React.ReactNode }) {
  return children;
}
