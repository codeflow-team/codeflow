import type { Tools }   from "../generated/tools";
// the library import, spaced oddly on purpose
import {   isAuthChange   } from "@flows/lib";

/** Flow: 안전 검사 — bảo mật 🔒 */
export default async function flow(
    input : { repository : string } ,
    tools : Tools
) {

  /* fetch the pull requests */
  const prs = await tools.github.getNewPRs( { repo : input.repository } ) ;
  for ( const pr of prs )
  {
        const files = await tools.github.getFiles( { pr } ) ;    // changed files
        if ( files.some( isAuthChange ) )
        {
      await tools.slack.send( {
              channel : "#security" ,
              message : `Security PR: ${pr.title}`
      } ) ;
        }
  }

}
