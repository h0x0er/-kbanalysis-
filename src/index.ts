import * as core from "@actions/core"
import * as github from "@actions/github"
import { existsSync, fstat, readFileSync } from "fs";
import { exit } from "process";
import { createPR } from "./pr_utils";
import { isKBIssue, getAction, getActionYaml, findToken, printArray, comment, getRunsON, getReadme, checkDependencies, findEndpoints, permsToString, isValidLang, actionSecurity, getTokenInput, normalizePerms} from "./utils"

try{

    const issue_id = core.getInput("issue-id");
    const token = core.getInput("github-token")
    
    const repos = github.context.repo // context repo
    const event = github.context.eventName

    const client = github.getOctokit(token) // authenticated octokit
    const resp = await client.rest.issues.get({issue_number: Number(issue_id ), owner: repos.owner, repo:repos.repo})

    const title = resp.data.title // extracting title of the issue.

    if(isKBIssue(title)){
        const issue_number = 71
        const comment_id = 1070348821 

        core.info("Executed by event: "+event)
        const action_name: String = getAction(title) // target action
        const action_name_split = action_name.split("/") 
        const target_owner = action_name_split[0]
        const target_repo = action_name_split[1]

        const comment_resp = await client.rest.issues.getComment({owner:repos.owner, repo:repos.repo, issue_number:issue_number, comment_id:comment_id})
        const comment_body = comment_resp.data.body
        if(comment_body.indexOf(`${target_owner}/${target_repo}`) !== -1){
            // issue already created for repo
            core.info(`Issue for ${target_owner}/${target_repo} is already created.\nExiting`)
            exit(0)
        }


        if(resp.data.state === "closed"){

            const content = readFileSync(`knowledge-base/${target_owner.toLocaleLowerCase()}/${target_repo.toLocaleLowerCase()}/action-security.yml`)
            let template = []
            template.push("At https://github.com/step-security/secure-workflows we are building a knowledge-base (KB) of permissions needed by different GitHub Actions. When developers try to remediate ossf/Scorecards checks, they use the knowledge-base to secure their GitHub Workflows.")
            template.push("Below you can see the KB of this action.")
            template.push("```yaml")
            template.push(content)
            template.push("```")
            template.push("This issue is automatically created by our analysis bot, feel free to close after reading :)")
            client.rest.issues.create({owner:"h0x0er", repo:"kb_setup", title:"GITHUB_TOKEN permissions used by this action", body: template.join("\n")})
            
            core.info(`Created issue in ${target_owner}/${target_repo}`)
            // updating comment 
            await client.rest.issues.updateComment({owner:repos.owner, repo:repos.repo, comment_id:comment_id, body:comment_resp.data.body+`\n${target_owner}/${target_repo}`})

        }

        core.info("===== Performing analysis =====")
        if(!existsSync(`knowledge-base/${target_owner.toLocaleLowerCase()}/${target_repo.toLocaleLowerCase()}/action-security.yml`)){
            
        
        const repo_info = await client.rest.repos.get({owner:target_owner, repo: target_repo.split("/")[0]}) // info related to repo.
        

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
        core.info(`Stars: ${repo_info.data.stargazers_count}`)
        core.info(`Private: ${repo_info.data.private}`)

        try{
            const action_data = await getActionYaml(client, target_owner, target_repo)
            const readme_data = await getReadme(client, target_owner, target_repo)

            const start = action_data.indexOf("name:")
            const action_yaml_name = action_data.substring(start, start+action_data.substring(start,).indexOf("\n"))

            const action_type = getRunsON(action_data)
            core.info(`Action Type: ${action_type}`)

            let matches:String[] = [] // // list holding all matches.
            const action_matches = await findToken(action_data) 
            if(readme_data !== null){
                const readme_matches = await findToken(readme_data)
                if(readme_matches !== null){
                    matches.push(...readme_matches) // pushing readme_matches in main matches.
                }
            }
            if(action_matches !== null){
                matches.push(...action_matches)
            }
            if(matches.length === 0){
                // no github_token pattern found in action_file & readme file 
                core.warning("Action doesn't contains reference to github_token")
                const template = `\n\`\`\`yaml\n${action_yaml_name} # ${target_owner+"/"+target_repo}\n# GITHUB_TOKEN not used\n\`\`\`\n`
                const pr_content = `${action_yaml_name} # ${target_owner+"/"+target_repo}\n# GITHUB_TOKEN not used\n`
                await createPR(pr_content, `knowledge-base/${target_owner}/${target_repo}`)

                await comment(client, repos, Number(issue_id), "This action's `action.yml` & `README.md` doesn't contains any reference to GITHUB_TOKEN\n### action-security.yml\n"+template)
            }else{
                // we found some matches for github_token
                matches = matches.filter((value, index, self)=>self.indexOf(value)===index) // unique matches only.
                core.info("Pattern Matches: "+matches.join(","))
                
                if(lang === "NOT_FOUND" || action_type === "Docker" || action_type === "Composite"){
                    // Action is docker or composite based no need to perform token_queries
                    const body = `### Analysis\n\`\`\`yml\nAction Name: ${action_name}\nAction Type: ${action_type}\nGITHUB_TOKEN Matches: ${matches}\nStars: ${repo_info.data.stargazers_count}\nPrivate: ${repo_info.data.private}\nForks: ${repo_info.data.forks_count}\n\`\`\``
                    await comment(client, repos, Number(issue_id), body)

                }else{
                    // Action is Node Based
                    let is_used_github_api = false 
                    if(isValidLang(lang)){
                        is_used_github_api =  await checkDependencies(client, target_owner, target_repo)
                    }
                    core.info(`Github API used: ${is_used_github_api}`)
                    let paths_found = [] // contains url to files
                    let src_files = [] // contains file_paths relative to repo.

                    for(let match of matches){
                        const query = `${match}+in:file+repo:${target_owner}/${target_repo}+language:${lang}`
                        const res = await client.rest.search.code({q: query})
                        
                        const items = res.data.items.map(item=>item.html_url)
                        const src = res.data.items.map(item=>item.path)
                        
                        paths_found.push(...items)
                        src_files.push(...src)
                    }
                    
                    const filtered_paths = paths_found.filter((value, index, self)=>self.indexOf(value)===index)
                    src_files = src_files.filter((value, index, self)=>self.indexOf(value)===index) // filtering src files.
                    core.info(`Src File found: ${src_files}`)
                    let body = `### Analysis\n\`\`\`yml\nAction Name: ${action_name}\nAction Type: ${action_type}\nGITHUB_TOKEN Matches: ${matches}\nTop language: ${lang}\nStars: ${repo_info.data.stargazers_count}\nPrivate: ${repo_info.data.private}\nForks: ${repo_info.data.forks_count}\n\`\`\``
                    

                    let action_security_yaml = ""
                    const valid_input = getTokenInput(action_data, matches)
                    let token_input = valid_input !== "env_var" ? `action-input:\n    input: ${valid_input}` : `environment-variable-name: <FigureOutYourself>`

                    if(is_used_github_api){
                        if(src_files.length !== 0){
                            body += "\n### Endpoints Found\n"
                            const perms = await findEndpoints(client, target_owner, target_repo, src_files)
                            if(perms !== {}){
                                let str_perms = permsToString(perms)
                                body += str_perms
                                core.info(`${str_perms}`)
                                action_security_yaml += actionSecurity({name:action_yaml_name, token_input: token_input, perms:normalizePerms(perms)})


                            }
 
                        }
                       
                    }

                    if(filtered_paths.length !== 0){
                        body += `\n#### FollowUp Links.\n${filtered_paths.join("\n")}\n`

                    }

                    body += "\n### action-security.yml\n"+action_security_yaml

                    await comment(client, repos, Number(issue_id), body)
                    
                    printArray(filtered_paths, "Paths Found: ")
                }
 
            }

        }catch(err){
            core.setFailed(err)
        }


        }else{
            core.info("Not performing analysis as issue is already analyzed")
        }
    }else{
        core.info("Not performing analysis as issue is not a valid KB issue")
    }
  

}catch(err){
    core.setFailed(err)
}