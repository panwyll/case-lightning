/** Local development only: a secure-link page with no database behind it, to walk its steps on /f/dev-preview-link-000000. */
export const DEV_SHARE_TOKEN = 'dev-preview-link-000000';
export const isDevShare = (token: string) => process.env.NODE_ENV === 'development' && token === DEV_SHARE_TOKEN;
export const devShareContext = (open: boolean) => ({ status: 'ok', firmName: 'Your Firm LLP', propertyAddress: '14 Oak Street, Leeds LS1 2AB', files: ['Report on title.docx', 'Local search.pdf'], open, codeTo: ['p••••••@hotmail.com'] });
export const DEV_SHARE_CODE = '123456';
