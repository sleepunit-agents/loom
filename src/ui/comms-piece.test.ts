import { expect, it } from 'vitest';
import { replyHtml } from '../../web/src/pieces/comms/render.js';
it('preserves Comms reply sanitising: no HTML, images, insecure schemes, or arbitrary internal links',()=>{
 const html=replyHtml('<script>alert(1)</script> ![image](https://evil.invalid/x) [bad](javascript:alert(1)) [insecure](http://evil.invalid) [inside](https://loom.invalid/a/art/anything) [ok](https://example.com)');
 expect(html).not.toMatch(/<script|<img|href="(?:javascript:|http:|https:\/\/loom.invalid)/i);expect(html).toContain('href="https://example.com"');expect(html).toContain('noopener noreferrer');
});
