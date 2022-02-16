import * as core from "@actions/core"
import * as github from "@actions/github"
import { isKBIssue, getAction, getActionYaml, findToken, printArray, comment, getRunsON, getReadme, checkDependencies, findEndpoints, permsToString} from "./utils"

try{

    const issue_id = core.getInput("issue-id");
    const token = core.getInput("github-token")
    
    const repos = github.context.repo // context repo

    const client = github.getOctokit(token) // authenticated octokit
    const resp = await client.rest.issues.get({issue_number: Number(issue_id ), owner: repos.owner, repo:repos.repo})

    const title = resp.data.title // extracting title of the issue.

    if(isKBIssue(title)){
        core.info("===== Performing analysis =====")
        const action_name: String = getAction(title) // target action
        const action_name_split = action_name.split("/") 
        const target_owner = action_name_split[0]
        const target_repo = action_name_split.length > 2 ? action_name_split.slice(1,).join("/") : action_name_split[1]

        let lang:String = ""
        try{
            const langs = await client.rest.repos.listLanguages({owner:target_owner, repo:target_repo})
            lang = Object.keys(langs.data)[0] // top language used in repo
        }catch(err){
            lang = "NOT_FOUND"
        }
        
        core.info(`Issue Title: ${title}`)
        core.info(`Action: ${action_name}`) 
        core.info(`Top language: ${lang}`)

        try{
            const action_data = await getActionYaml(client, target_owner, target_repo)
            const readme_data = await getReadme(client, target_owner, target_repo)

            const action_type = getRunsON(action_data)
            core.info(`Action Type: ${action_type}`)

            let matches:String[] = [] // // list holding all matches.
            const action_matches = await findToken(action_data) 
            const readme_matches = await findToken(readme_data)
            if(readme_matches !== null){
                matches.push(...readme_matches) // pushing readme_matches in main matches.
            }
            if(action_matches !== null){
                matches.push(...action_matches)
            }

            if(matches.length === 0){
                // no github_token pattern found in action_file & readme file 
                core.warning("Action doesn't contains reference to github_token")
                await comment(client, repos, Number(issue_id), "This action's `action.yml` & `README.md` doesn't contains any reference to GITHUB_TOKEN")
            }else{
                // we found some matches for github_token
                matches = matches.filter((value, index, self)=>self.indexOf(value)===index) // unique matches only.
                core.info("Pattern Matches: "+matches.join(","))
                if(lang === "NOT_FOUND"){
                    // Action is docker or composite based no need to perform token_queries
                    const body = `### Analysis\nAction Name: ${action_name}\nAction Type: ${action_type}\nGITHUB_TOKEN Matches: ${matches}`
                    await comment(client, repos, Number(issue_id), body)

                }else{
                    // Action is Node Based
                    const is_used_github_api = await checkDependencies(client, target_owner, target_repo)
                    core.info(`Github API used: ${is_used_github_api}`)
                    let paths_found = [] // contains url to files
                    let src_files = [] // contains file_paths relative to repo.

                    for(let match of matches){
                        const query = `${match}+in:file+repo:${target_owner}/${target_repo}+language:${lang}`
                        const res = await client.rest.search.code({q: query})
                        
                        const items = res.data.items.map(item=>item.html_url)
                        const src_files = res.data.items.map(item=>item.path)
                        
                        paths_found.push(...items)
                        src_files.push(...src_files)
                    }
                    
                    const filtered_paths = paths_found.filter((value, index, self)=>self.indexOf(value)===index)
                    console.log(`Src File found: ${src_files}`)
                    let body = `### Analysis\nAction Name: ${action_name}\nAction Type: ${action_type}\nGITHUB_TOKEN Matches: ${matches}\nTop language: ${lang}\n`

                    if(is_used_github_api){
                        if(src_files.length !== 0){
                            body += "\n### Endpoints Found\n"
                            const perms = await findEndpoints(client, target_owner, target_repo, src_files)
                            body += permsToString(perms)
                        }
                       
                    }
                    
                    body += `#### FollowUp Links.\n${filtered_paths.join("\n")}`


                    await comment(client, repos, Number(issue_id), body)
                    
                    printArray(filtered_paths, "Paths Found: ")
                }
 
            }

        }catch(err){
            core.setFailed(err)
        }


    }else{
        core.info("Not performing analysis as issue is not a valid KB issue")
    }
  

}catch(err){
    core.setFailed(err)
}