import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Book A Demo — CONVEYi | Case Lightning',
  description: 'Fifteen minutes on your own kind of cases: what CONVEYi would take off your fee earners, and how we measure it. You pay nothing until your caseload has doubled.',
};

export default function DemoLayout({ children }: { children: React.ReactNode }) {
  return children;
}
