import { NextRequest } from 'next/server';
import { config } from '@/lib/server/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Serves the Outlook add-in manifest with every URL pointing at the deployment's
 * own origin — so the same endpoint works on localhost, Vercel previews, and prod
 * with zero hand-editing. Sideload this URL (or save it as manifest.xml):
 *   https://<your-domain>/addin/manifest
 *
 * Origin precedence: APP_URL (when not localhost) → forwarded host headers → request URL.
 */
function resolveOrigin(req: NextRequest): string {
  if (config.appUrl && !config.appUrl.includes('localhost')) return config.appUrl.replace(/\/$/, '');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  const proto = req.headers.get('x-forwarded-proto') ?? 'https';
  if (host) return `${proto}://${host}`;
  return req.nextUrl.origin;
}

// Stable add-in identity — keep this GUID constant across deployments.
const ADDIN_ID = '6ac8bf48-cb10-4ba5-8469-5fd32f77d4b0';

function manifest(origin: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<OfficeApp xmlns="http://schemas.microsoft.com/office/appforoffice/1.1"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
  xmlns:bt="http://schemas.microsoft.com/office/officeappbasictypes/1.0"
  xmlns:mailappor="http://schemas.microsoft.com/office/mailappversionoverrides/1.0"
  xsi:type="MailApp">
  <Id>${ADDIN_ID}</Id>
  <Version>1.0.0.0</Version>
  <ProviderName>CaseLightning</ProviderName>
  <DefaultLocale>en-GB</DefaultLocale>
  <DisplayName DefaultValue="CaseLightning"/>
  <Description DefaultValue="Case-aware AI email drafting and AI case management for UK conveyancers — inside Outlook."/>
  <IconUrl DefaultValue="${origin}/addin/icon-64.png"/>
  <HighResolutionIconUrl DefaultValue="${origin}/addin/icon-128.png"/>
  <SupportUrl DefaultValue="${origin}/how-it-works"/>
  <AppDomains>
    <AppDomain>${origin}</AppDomain>
  </AppDomains>
  <Hosts>
    <Host Name="Mailbox"/>
  </Hosts>
  <Requirements>
    <Sets>
      <Set Name="Mailbox" MinVersion="1.8"/>
    </Sets>
  </Requirements>
  <FormSettings>
    <Form xsi:type="ItemRead">
      <DesktopSettings>
        <SourceLocation DefaultValue="${origin}/addin/taskpane"/>
        <RequestedHeight>450</RequestedHeight>
      </DesktopSettings>
    </Form>
  </FormSettings>
  <Permissions>ReadWriteMailbox</Permissions>
  <Rule xsi:type="RuleCollection" Mode="Or">
    <Rule xsi:type="ItemIs" ItemType="Message" FormType="Read"/>
  </Rule>
  <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides" xsi:type="VersionOverridesV1_0">
    <VersionOverrides xmlns="http://schemas.microsoft.com/office/mailappversionoverrides/1.1" xsi:type="VersionOverridesV1_1">
      <Hosts>
        <Host xsi:type="MailHost">
          <DesktopFormFactor>
            <FunctionFile resid="Taskpane.Url"/>
            <ExtensionPoint xsi:type="MessageReadCommandSurface">
              <OfficeTab id="TabDefault">
                <Group id="caseLightningGroup">
                  <Label resid="GroupLabel"/>
                  <Control xsi:type="Button" id="openTaskpaneButton">
                    <Label resid="TaskpaneButton.Label"/>
                    <Supertip>
                      <Title resid="TaskpaneButton.Label"/>
                      <Description resid="TaskpaneButton.Tooltip"/>
                    </Supertip>
                    <Icon>
                      <bt:Image size="16" resid="Icon.16x16"/>
                      <bt:Image size="32" resid="Icon.32x32"/>
                      <bt:Image size="80" resid="Icon.80x80"/>
                    </Icon>
                    <Action xsi:type="ShowTaskpane">
                      <SourceLocation resid="Taskpane.Url"/>
                    </Action>
                  </Control>
                </Group>
              </OfficeTab>
            </ExtensionPoint>
          </DesktopFormFactor>
        </Host>
      </Hosts>
      <Resources>
        <bt:Images>
          <bt:Image id="Icon.16x16" DefaultValue="${origin}/addin/icon-16.png"/>
          <bt:Image id="Icon.32x32" DefaultValue="${origin}/addin/icon-32.png"/>
          <bt:Image id="Icon.80x80" DefaultValue="${origin}/addin/icon-80.png"/>
        </bt:Images>
        <bt:Urls>
          <bt:Url id="Taskpane.Url" DefaultValue="${origin}/addin/taskpane"/>
        </bt:Urls>
        <bt:ShortStrings>
          <bt:String id="GroupLabel" DefaultValue="CaseLightning"/>
          <bt:String id="TaskpaneButton.Label" DefaultValue="Open CaseLightning"/>
        </bt:ShortStrings>
        <bt:LongStrings>
          <bt:String id="TaskpaneButton.Tooltip" DefaultValue="Open the case-aware drafting & case-management sidebar."/>
        </bt:LongStrings>
      </Resources>
    </VersionOverrides>
  </VersionOverrides>
</OfficeApp>`;
}

export async function GET(req: NextRequest) {
  const xml = manifest(resolveOrigin(req));
  return new Response(xml, {
    headers: {
      'content-type': 'application/xml; charset=utf-8',
      'content-disposition': 'inline; filename="caselightning-manifest.xml"',
      'cache-control': 'no-store',
    },
  });
}
